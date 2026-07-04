import { describe, it, expect } from "vitest";
import { Agent, newSessionState } from "./agent";
import { Sim } from "./sim";
import { MockProvider, validateAction, type Provider } from "../inference/inference";
import type { Action, Advisory, RackState, RiskClassification, Snapshot } from "../shared/types";

/* -------------------------------- fixtures --------------------------------- */

function rackState(id: string, over: Partial<RackState> = {}): RackState {
  return {
    id,
    row: id[0],
    position: Number(id.slice(1)),
    gpu_temp_c: 60,
    projected_temp_5m: 60,
    time_to_throttle_s: null,
    headroom_w: 5000,
    band: "nominal",
    utilization_pct: 50,
    power_draw_w: 3000,
    active_jobs: [],
    ...over,
  };
}

function snapshotWith(racks: RackState[], constraints: Snapshot["constraints"] = []): Snapshot {
  return {
    sim_time_s: 120,
    cluster_note: "test",
    racks,
    queue: { pending: [], recent_placements: [] },
    constraints,
    recent_advisories: [],
    focus_rack_id: "B7",
    trigger: "band_cross",
  };
}

const migrateJob = (over: Partial<Action> = {}): Action => ({
  type: "migrate_job",
  params: { job_id: "job-4471", from_rack: "B7", to_rack: "B12" },
  one_line: "migrate",
  ...over,
});

/** A scripted provider for exercising the feasibility loop. */
class ScriptedProvider implements Provider {
  private i = 0;
  constructor(private actions: Action[]) {}
  async classifyRisk(snapshot: Snapshot): Promise<RiskClassification[]> {
    return snapshot.racks.map((r) => ({ rack_id: r.id, risk: "at_risk" as const }));
  }
  async advise(snapshot: Snapshot): Promise<Advisory> {
    const action = this.actions[Math.min(this.i, this.actions.length - 1)];
    this.i += 1;
    return {
      id: "stub",
      ts: snapshot.sim_time_s,
      severity: "warn",
      area: snapshot.focus_rack_id ?? "B7",
      headline: "stub advisory",
      rationale: "B7 at 68 C, headroom -630 W.",
      action,
      alternatives: [],
      confidence: 0.8,
      learned_from: null,
      origin: "model",
    };
  }
  async why(): Promise<string> {
    return "stub";
  }
}

/* ----------------------------- validateAction ------------------------------ */

describe("validateAction (action feasibility)", () => {
  const job = { id: "job-4471", priority: "high" as const, power_w: 700, sla: "" };
  const focus = rackState("B7", { active_jobs: [job], headroom_w: -630, power_draw_w: 6300 });

  it("accepts a migrate to a rack with headroom and no constraint", () => {
    const snap = snapshotWith([focus, rackState("B12", { headroom_w: 5100, power_draw_w: 3000 })]);
    expect(validateAction(migrateJob(), snap)).toEqual({ ok: true });
  });

  it("rejects a migrate onto an excluded rack", () => {
    const snap = snapshotWith(
      [focus, rackState("B12", { headroom_w: 5100 })],
      [{ id: "c1", kind: "exclude_rack", target: "B12", reason: "maintenance", ts: 100, source: "override" }],
    );
    const res = validateAction(migrateJob(), snap);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("excluded");
  });

  it("rejects a migrate onto an avoided row", () => {
    const snap = snapshotWith(
      [focus, rackState("B12", { headroom_w: 5100 })],
      [{ id: "c2", kind: "avoid_row", target: "B", reason: "row maintenance", ts: 100, source: "operator" }],
    );
    expect(validateAction(migrateJob(), snap).ok).toBe(false);
  });

  it("rejects moving a pinned job", () => {
    const snap = snapshotWith(
      [focus, rackState("B12", { headroom_w: 5100 })],
      [{ id: "c3", kind: "pin_job", target: "job-4471", reason: "do not move", ts: 100, source: "operator" }],
    );
    expect(validateAction(migrateJob(), snap).ok).toBe(false);
  });

  it("rejects a target without enough headroom for the job", () => {
    const snap = snapshotWith([focus, rackState("B12", { headroom_w: 500 })]);
    const res = validateAction(migrateJob(), snap);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("headroom");
  });

  it("rejects a target that would exceed the power budget", () => {
    const snap = snapshotWith([focus, rackState("B12", { headroom_w: 700, power_draw_w: 11500 })]);
    const res = validateAction(migrateJob(), snap);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("budget");
  });

  it("treats non-migrate actions as structurally valid", () => {
    const snap = snapshotWith([focus]);
    expect(validateAction({ type: "cap_intake", params: { from_rack: "B7" }, one_line: "cap" }, snap).ok).toBe(true);
    expect(validateAction({ type: "hold", params: {}, one_line: "hold" }, snap).ok).toBe(true);
  });

  it("rejects a migrate that breaks a co-location, accepts the one that preserves it", () => {
    const coJob = { id: "job-4471", priority: "high" as const, power_w: 700, sla: "", co_located_with: "job-4470" };
    const partner = { id: "job-4470", priority: "high" as const, power_w: 900, sla: "" };
    const co = migrateJob({ params: { job_id: "job-4471", from_rack: "B7", to_rack: "B15" }, one_line: "" });
    const snap = snapshotWith([
      rackState("B7", { active_jobs: [coJob], headroom_w: -630 }),
      rackState("B3", { headroom_w: 3100, active_jobs: [partner] }),
      rackState("B15", { headroom_w: 5400 }), // most headroom, but does not host the partner
    ]);
    const toB15 = validateAction(co, snap);
    expect(toB15.ok).toBe(false); // greedy headroom pick breaks co-location
    if (!toB15.ok) expect(toB15.reason).toContain("co-location");
    const toB3 = validateAction({ ...co, params: { ...co.params, to_rack: "B3" } }, snap);
    expect(toB3.ok).toBe(true); // B3 hosts the partner
  });
});

/* ------------------------------ feasibility loop --------------------------- */

describe("agent feasibility loop", () => {
  it("re-prompts the model when the first action is infeasible, then surfaces the feasible one", async () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(120);
    const bad = migrateJob({ params: { job_id: "job-4471", from_rack: "B7", to_rack: "ZZ9" }, one_line: "bad" });
    const good = migrateJob({ params: { job_id: "job-4471", from_rack: "B7", to_rack: "B3" }, one_line: "good" });
    const agent = new Agent(new ScriptedProvider([bad, good]));
    const advisory = await agent.solveAdvisory(sim, "B7", "band_cross", newSessionState());
    expect(advisory.action.params.to_rack).toBe("B3");
    expect(advisory.origin).toBe("model");
  });

  it("falls back to the rule-based advisory when the model stays infeasible", async () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(120);
    const bad = migrateJob({ params: { job_id: "job-4471", from_rack: "B7", to_rack: "ZZ9" }, one_line: "bad" });
    const agent = new Agent(new ScriptedProvider([bad]));
    const advisory = await agent.solveAdvisory(sim, "B7", "band_cross", newSessionState());
    expect(advisory.origin).toBe("auto");
  });
});

/* --------------------------------- debounce -------------------------------- */

describe("advisory debounce", () => {
  it("suppresses a repeat within the debounce window but re-fires on escalation", async () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(120); // surge: B7 projected warn
    const agent = new Agent(new MockProvider());
    const session = newSessionState();

    const first = await agent.tick(sim, session);
    expect(first.advisory).toBeDefined();
    const count = session.records.length;

    const repeat = await agent.tick(sim, session); // same tick, still pending
    expect(repeat.advisory).toBeUndefined();
    expect(session.records.length).toBe(count);

    sim.advance(60); // B7 projected crosses into critical -> severity escalates
    const escalated = await agent.tick(sim, session);
    expect(escalated.advisory).toBeDefined();
  });

  it("re-fires after the debounce window once the pending advisory is cleared", async () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(180); // B7 already critical
    const agent = new Agent(new MockProvider());
    const session = newSessionState();

    const first = await agent.tick(sim, session);
    expect(first.advisory).toBeDefined();
    agent.handleDismiss(sim, session, first.advisory!.id); // clears pending, keeps debounce clock

    sim.advance(10); // < DEBOUNCE_S, no escalation
    expect((await agent.tick(sim, session)).advisory).toBeUndefined();

    sim.advance(20); // now past DEBOUNCE_S
    expect((await agent.tick(sim, session)).advisory).toBeDefined();
  });
});

/* ------------------------- the S1 override-learning path -------------------- */

describe("S1 override and learning path (MockProvider)", () => {
  it("co-locates on B3 not the greedy B15, learns the B3 exclusion, bends the curve, avoids B3 next time", async () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(120);
    const agent = new Agent(new MockProvider());
    const session = newSessionState();

    // 1. First WARN co-locates job-4471 with job-4470 on B3, and flags what a headroom rule does.
    const a1 = (await agent.tick(sim, session)).advisory!;
    expect(a1.headline).toContain("B7");
    expect(a1.action.params.to_rack).toBe("B3");
    expect(a1.learned_from).toBeNull();
    expect(a1.rule_pick?.to_rack).toBe("B15"); // the greedy headroom pick
    expect(a1.rule_pick?.flaw).toContain("co-location");

    // 2. Override: exclude B3 (firmware). Co-location is lost, so re-solve to B15, learned rule set.
    const a2 = await agent.handleOverride(sim, session, a1.id, "firmware update in 10 min", {
      kind: "exclude_rack",
      target: "B3",
      reason: "firmware update in 10 min",
    });
    expect(a2).not.toBeNull();
    expect(a2!.action.params.to_rack).toBe("B15");
    expect(a2!.action.params.to_rack).not.toBe("B3");
    expect(a2!.learned_from).toBe("c1");
    expect(a2!.rule_pick).toBeUndefined(); // co-location no longer achievable -> no contrast
    expect(a2!.origin).toBe("model"); // the re-solve comes from the model, not the fallback
    expect(a1.origin).toBe("model");
    expect(session.records.find((r) => r.advisory.id === a1.id)!.outcome).toBe("overridden");

    // 3. Approve the re-solve: B7 projected temperature bends down.
    const projBefore = sim.getRackStates().find((r) => r.id === "B7")!.projected_temp_5m;
    expect(agent.handleApprove(sim, session, a2!.id)).toBe(true);
    const projAfter = sim.getRackStates().find((r) => r.id === "B7")!.projected_temp_5m;
    expect(projAfter).toBeLessThan(projBefore);

    // 4. Second event: A-row spikes with its own co-location on B3; the agent avoids B3 (learned).
    sim.advance(200); // past the A-row surge at t=300
    const a3 = (await agent.tick(sim, session)).advisory!;
    expect(a3.action.params.to_rack).not.toBe("B3");
    expect(a3.learned_from).toBe("c1");
  });

  it("composes a resolution once the cluster returns to nominal after an approval", async () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(120);
    const agent = new Agent(new MockProvider());
    const session = newSessionState();
    const a1 = (await agent.tick(sim, session)).advisory!;
    agent.handleApprove(sim, session, a1.id);
    sim.advance(120);
    const resolution = agent.maybeResolve(sim, session);
    expect(resolution).not.toBeNull();
    expect(resolution!.timeline.length).toBeGreaterThan(0);
  });
});
