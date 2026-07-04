/**
 * Marshal's agent loop (docs/AGENT_SPEC.md). Per tick it computes RackState (in the Sim),
 * finds the at-risk set, runs the two-tier inference (DeepSeek classify -> Nemotron advise),
 * validates each proposed action against physics and the operator's constraints, and surfaces
 * one feasible advisory at a time. It also owns approve/override/dismiss/why and the
 * deterministic resolution. Code computes every number; the model only reconciles constraints.
 */
import { SIM } from "../shared/types";
import type {
  Advisory,
  AdvisoryRecord,
  Constraint,
  ConstraintKind,
  RackState,
  Resolution,
  Snapshot,
  SnapshotTrigger,
  ThermalBand,
} from "../shared/types";
import { validateAction, ruleBasedAdvisory, type Provider } from "../inference/inference";
import { Sim, band } from "./sim";

const SEV_RANK: Record<ThermalBand, number> = { nominal: 0, watch: 1, warn: 2, critical: 3 };

export interface OverrideConstraintInput {
  kind: ConstraintKind;
  target: string;
  reason: string;
}

/** Shared, DO-owned world state the agent reads and writes. */
export interface SessionState {
  constraints: Constraint[];
  records: AdvisoryRecord[];
  timeline: { ts: number; label: string }[];
  incidentActive: boolean;
  approvedSinceResolution: boolean;
  lastResolutionTs: number;
}

export function newSessionState(): SessionState {
  return {
    constraints: [],
    records: [],
    timeline: [],
    incidentActive: false,
    approvedSinceResolution: false,
    lastResolutionTs: 0,
  };
}

export interface TickResult {
  status: string;
  advisory?: Advisory;
}

const projMargin = (s: RackState) => SIM.THROTTLE_TEMP_C - s.projected_temp_5m;
const projBand = (s: RackState): ThermalBand => band(s.projected_temp_5m);

export class Agent {
  private provider: Provider;
  private advState = new Map<string, { lastTs: number; lastSevRank: number; pending: boolean }>();
  private seq = 0;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  reset(): void {
    this.advState.clear();
    this.seq = 0;
  }

  /* ---------------------------------- the tick ------------------------------- */

  async tick(sim: Sim, session: SessionState): Promise<TickResult> {
    const states = sim.getRackStates();

    // Tier 1 (code, every tick): at-risk == projected band watch or worse.
    const atRisk = states.filter((s) => projMargin(s) <= SIM.BAND_WATCH_MARGIN_C);
    if (atRisk.length === 0) return { status: this.statusLine(sim, states, null) };

    // Only spend model calls on racks that are not debounced / already pending.
    const eligible = atRisk.filter((s) =>
      this.canIssue(s.id, SEV_RANK[projBand(s)], sim.simTime, false),
    );
    if (eligible.length === 0) return { status: this.statusLine(sim, states, this.mostUrgent(atRisk)) };

    // Tier 2 (DeepSeek): triage. Only "at_risk" racks escalate to the heavy model.
    const snap = this.buildSnapshot(sim, this.mostUrgent(eligible).id, "band_cross", session);
    const classes = await this.provider.classifyRisk(snap);
    const atRiskIds = new Set(classes.filter((c) => c.risk === "at_risk").map((c) => c.rack_id));
    const escalate = eligible.filter((s) => atRiskIds.has(s.id));
    if (escalate.length === 0) return { status: this.statusLine(sim, states, this.mostUrgent(eligible)) };

    // Tier 3 (Nemotron): one advisory for the single most urgent at-risk rack.
    const focus = this.mostUrgent(escalate);
    const advisory = await this.solveAdvisory(sim, focus.id, "band_cross", session);
    this.markIssued(focus.id, SEV_RANK[projBand(focus)], sim.simTime);
    this.pushRecord(session, advisory);
    session.incidentActive = true;
    session.timeline.push({ ts: sim.simTime, label: `${advisory.severity} ${advisory.area}: ${advisory.headline}` });
    return { advisory, status: this.statusLine(sim, states, focus) };
  }

  /* --------------------------- advisory + feasibility ------------------------ */

  /**
   * Heavy-tier advisory with the action-feasibility loop (AGENT_SPEC 4b): validate the
   * proposed action; on a violation, re-prompt the SAME model with the specific reason, up to
   * two times; if still infeasible, fall back to the deterministic rule-based advisory.
   */
  async solveAdvisory(
    sim: Sim,
    focusId: string,
    trigger: SnapshotTrigger,
    session: SessionState,
  ): Promise<Advisory> {
    const snap = this.buildSnapshot(sim, focusId, trigger, session);
    let advisory = await this.provider.advise(snap);
    for (let attempt = 0; attempt < 2; attempt++) {
      const check = validateAction(advisory.action, snap);
      if (check.ok) return this.finalize(advisory, snap, trigger);
      advisory = await this.provider.advise(
        snap,
        `That action is infeasible: ${check.reason}. Propose a different action that satisfies it.`,
      );
    }
    if (validateAction(advisory.action, snap).ok) return this.finalize(advisory, snap, trigger);
    return this.finalize(ruleBasedAdvisory(snap), snap, trigger);
  }

  /** Code owns id/ts and enforces the learned_from rule (AGENT_SPEC 5). */
  private finalize(advisory: Advisory, snap: Snapshot, trigger: SnapshotTrigger): Advisory {
    let out: Advisory = {
      ...advisory,
      id: `adv-${++this.seq}-${snap.focus_rack_id ?? "focus"}`,
      ts: snap.sim_time_s,
    };
    if (trigger === "override") {
      const c = [...snap.constraints].reverse().find((x) => x.source === "override");
      if (c) out = { ...out, learned_from: c.id };
    } else if (out.learned_from == null && out.action.type === "migrate_job") {
      const excl = snap.constraints.find((x) => x.source === "override" && x.kind === "exclude_rack");
      if (excl && out.action.params.to_rack !== excl.target) out = { ...out, learned_from: excl.id };
    }
    return out;
  }

  /* --------------------------------- controls -------------------------------- */

  /** Approve: apply the action as an effect that mutates sim heat power. */
  handleApprove(sim: Sim, session: SessionState, advisoryId: string): boolean {
    const rec = session.records.find((r) => r.advisory.id === advisoryId);
    if (!rec || rec.outcome !== "pending") return false;
    sim.applyAction(rec.advisory.action, advisoryId);
    rec.outcome = "approved";
    rec.resolved_ts = sim.simTime;
    this.clearPending(this.focusOf(rec.advisory));
    session.approvedSinceResolution = true;
    session.timeline.push({ ts: sim.simTime, label: `approved: ${rec.advisory.action.one_line}` });
    return true;
  }

  /**
   * Override: add the structured constraint, mark the record overridden, and immediately
   * re-solve for the same focus rack with trigger "override". The new advisory must reconcile
   * the constraint and set learned_from (AGENT_SPEC 5).
   */
  async handleOverride(
    sim: Sim,
    session: SessionState,
    advisoryId: string,
    reason: string,
    constraintInput?: OverrideConstraintInput,
  ): Promise<Advisory | null> {
    const rec = session.records.find((r) => r.advisory.id === advisoryId);
    if (!rec) return null;
    const focusId = this.focusOf(rec.advisory);

    const constraint: Constraint = {
      id: `c${session.constraints.length + 1}`,
      kind: constraintInput?.kind ?? "exclude_rack",
      target: constraintInput?.target ?? "",
      reason: constraintInput?.reason ?? reason,
      ts: sim.simTime,
      source: "override",
    };
    session.constraints.push(constraint);
    rec.outcome = "overridden";
    rec.operator_reason = reason;
    rec.resolved_ts = sim.simTime;
    this.clearPending(focusId);
    session.timeline.push({
      ts: sim.simTime,
      label: `override: ${constraint.kind} ${constraint.target} — ${reason}`,
    });

    const advisory = await this.solveAdvisory(sim, focusId, "override", session);
    this.pushRecord(session, advisory);
    const focusState = sim.getRackStates().find((s) => s.id === focusId);
    this.markIssued(focusId, focusState ? SEV_RANK[projBand(focusState)] : SEV_RANK.warn, sim.simTime);
    session.timeline.push({ ts: sim.simTime, label: `re-solve: ${advisory.headline}` });
    return advisory;
  }

  handleDismiss(sim: Sim, session: SessionState, advisoryId: string): boolean {
    const rec = session.records.find((r) => r.advisory.id === advisoryId);
    if (!rec || rec.outcome !== "pending") return false;
    rec.outcome = "dismissed";
    rec.resolved_ts = sim.simTime;
    this.clearPending(this.focusOf(rec.advisory));
    session.timeline.push({ ts: sim.simTime, label: `dismissed: ${rec.advisory.headline}` });
    return true;
  }

  /** Why: a heavy-tier explanation citing snapshot numbers, no new recommendation. */
  async why(sim: Sim, session: SessionState, advisoryId: string): Promise<string> {
    const rec = session.records.find((r) => r.advisory.id === advisoryId);
    const focusId = rec ? this.focusOf(rec.advisory) : this.hottestId(sim);
    const snap = this.buildSnapshot(sim, focusId, "why", session);
    const text = await this.provider.why(snap, advisoryId);
    session.timeline.push({ ts: sim.simTime, label: `why: ${advisoryId}` });
    return text;
  }

  /**
   * Resolution: when no rack is at risk and at least one action has been approved since the
   * last resolution, compose a deterministic incident summary from the tracked timeline.
   */
  maybeResolve(sim: Sim, session: SessionState): Resolution | null {
    const states = sim.getRackStates();
    if (states.some((s) => projMargin(s) <= SIM.BAND_WATCH_MARGIN_C)) return null;
    if (!session.incidentActive || !session.approvedSinceResolution) return null;

    const since = session.lastResolutionTs;
    const timeline = session.timeline.filter((e) => e.ts >= since).map((e) => ({ ts: e.ts, label: e.label }));
    const involved = session.records.filter((r) => (r.resolved_ts ?? r.advisory.ts) >= since);
    const learned = session.constraints.filter((c) => c.source === "override").map((c) => c.id);
    const area = involved.find((r) => r.outcome === "approved")?.advisory.area ?? "cluster";
    const approvals = involved.filter((r) => r.outcome === "approved").length;

    session.incidentActive = false;
    session.approvedSinceResolution = false;
    session.lastResolutionTs = sim.simTime;

    return {
      id: `res-${Math.round(sim.simTime)}`,
      ts: sim.simTime,
      area,
      summary: `${area} incident resolved: ${approvals} action(s) approved, ${learned.length} operator rule(s) learned, all racks back to nominal.`,
      timeline,
      advisories: involved.map((r) => r.advisory.id),
      learned_constraints: learned,
    };
  }

  /* --------------------------------- helpers --------------------------------- */

  private buildSnapshot(sim: Sim, focusId: string, trigger: SnapshotTrigger, session: SessionState): Snapshot {
    const states = sim.getRackStates();
    const atRisk = states.filter((s) => projMargin(s) <= SIM.BAND_WATCH_MARGIN_C);
    const atRiskIds = new Set(atRisk.map((s) => s.id));
    const candidates = states
      .filter((s) => !atRiskIds.has(s.id))
      .sort((a, b) => b.headroom_w - a.headroom_w)
      .slice(0, 5);

    const racks = new Map<string, RackState>();
    const focusState = states.find((s) => s.id === focusId);
    if (focusState) racks.set(focusState.id, focusState);
    for (const s of atRisk) racks.set(s.id, s);
    for (const s of candidates) racks.set(s.id, s);

    return {
      sim_time_s: sim.simTime,
      cluster_note: sim.clusterNote(states),
      racks: [...racks.values()],
      queue: sim.getQueue(),
      constraints: session.constraints,
      recent_advisories: session.records.slice(-3),
      focus_rack_id: focusId,
      trigger,
    };
  }

  private canIssue(rackId: string, sevRank: number, now: number, forced: boolean): boolean {
    if (forced) return true;
    const st = this.advState.get(rackId);
    if (!st) return true;
    if (sevRank > st.lastSevRank) return true; // severity escalated (e.g. warn -> critical)
    if (st.pending) return false; // one advisory at a time per rack
    return now - st.lastTs >= SIM.DEBOUNCE_S;
  }

  private markIssued(rackId: string, sevRank: number, now: number): void {
    this.advState.set(rackId, { lastTs: now, lastSevRank: sevRank, pending: true });
  }

  private clearPending(rackId: string): void {
    const st = this.advState.get(rackId);
    if (st) st.pending = false;
  }

  private focusOf(advisory: Advisory): string {
    return advisory.action.params.from_rack ?? advisory.area;
  }

  private mostUrgent(list: RackState[]): RackState {
    return [...list].sort((a, b) => {
      const ta = a.time_to_throttle_s ?? Number.POSITIVE_INFINITY;
      const tb = b.time_to_throttle_s ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return b.projected_temp_5m - a.projected_temp_5m;
    })[0];
  }

  private hottestId(sim: Sim): string {
    const states = sim.getRackStates();
    return [...states].sort((a, b) => b.gpu_temp_c - a.gpu_temp_c)[0]?.id ?? "cluster";
  }

  private pushRecord(session: SessionState, advisory: Advisory): void {
    session.records.push({ advisory, outcome: "pending" });
    if (session.records.length > 24) session.records = session.records.slice(-24);
  }

  private statusLine(sim: Sim, states: RackState[], focus: RackState | null): string {
    if (!focus) return `Marshal watching ${states.length} racks, ${sim.clusterNote(states)}`;
    const ttt = focus.time_to_throttle_s;
    const tail = ttt != null ? `, throttle in ${ttt}s` : "";
    return `Marshal analyzing ${focus.id}, projected ${focus.projected_temp_5m}C${tail}`;
  }
}
