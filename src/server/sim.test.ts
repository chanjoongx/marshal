import { describe, it, expect } from "vitest";
import {
  Sim,
  steadyState,
  stepTemp,
  projectTemp,
  timeToThrottle,
  headroomW,
  band,
  DREF,
} from "./sim";
import type { RackState } from "../shared/types";

/**
 * The thermal model is the executable contract with scripts/curve_check.mjs. These tests
 * reproduce the oracle's validated B7 curve two ways: with the pure functions and through the
 * full Sim engine, which must produce identical numbers. Constants come from SIM_SPEC (TAU=220,
 * B7 cooling 11340 W, surge to 12600 W). The oracle rows are copied from `npm run curve`.
 */

const B7_CAP = 11340;
const P0 = 6720; // nominal draw -> 62 C
const P1 = 12600; // after batch surge -> steady state 90 C
const ACTION_REMOVE = 4760; // migrate job-4471 (1400) + cap sheds 3 low-pri batch (3360)

// Mirror of curve_check.mjs run(), using the sim's own pure functions.
function oracleRun(withAction: boolean) {
  let T = steadyState(P0, B7_CAP);
  let crossed: number | null = null;
  let peakRate = 0;
  let prev = T;
  const rows: Record<number, { T: number; Tss: number; proj: number; ttt: number | null; hr: number; band: string; pband: string }> = {};
  for (let t = 0; t <= 600; t++) {
    let P = t < 120 ? P0 : P1;
    if (withAction && t >= 210) P = P1 - ACTION_REMOVE;
    const Tss = steadyState(P, B7_CAP);
    const proj = projectTemp(T, Tss);
    const ttt = timeToThrottle(T, Tss);
    if (crossed === null && T >= 84) crossed = t;
    if (t > 0) peakRate = Math.max(peakRate, Math.abs(T - prev));
    rows[t] = {
      T: +T.toFixed(1),
      Tss: +Tss.toFixed(1),
      proj: +proj.toFixed(1),
      ttt: ttt === null ? null : Math.round(ttt),
      hr: Math.round(headroomW(P, B7_CAP)),
      band: band(T),
      pband: band(proj),
    };
    prev = T;
    T = stepTemp(T, Tss, 1);
  }
  return { rows, crossed, peakRate, finalT: +T.toFixed(1) };
}

function b7After(seconds: number): RackState {
  const sim = new Sim();
  sim.start("S1");
  sim.advance(seconds);
  return sim.getRackStates().find((r) => r.id === "B7")!;
}

describe("thermal model matches the curve_check oracle", () => {
  it("uses the SIM_SPEC reference delta-T", () => {
    expect(DREF).toBe(54);
  });

  it("reproduces the S1 no-action B7 curve with the pure functions", () => {
    const { rows, crossed, peakRate } = oracleRun(false);
    expect(rows[120]).toMatchObject({ T: 62, Tss: 90, proj: 82.8, ttt: 339, hr: -1260, band: "nominal", pband: "warn" });
    expect(rows[160]).toMatchObject({ T: 66.7, proj: 84, band: "nominal", pband: "critical" });
    expect(rows[180]).toMatchObject({ T: 68.7, proj: 84.5, ttt: 279 });
    expect(rows[200]).toMatchObject({ T: 70.5, band: "watch" });
    expect(rows[340]).toMatchObject({ T: 79.7, proj: 87.4, band: "warn" });
    expect(rows[460]).toMatchObject({ T: 84, band: "critical" });
    expect(crossed).toBe(459); // unrounded T first crosses 84 C at 339 s after the surge
    expect(crossed! - 120).toBeGreaterThanOrEqual(280);
    expect(crossed! - 120).toBeLessThanOrEqual(360);
    expect(peakRate).toBeLessThanOrEqual(0.2);
  });

  it("reproduces the S1 with-action B7 curve with the pure functions", () => {
    const { rows, crossed, finalT } = oracleRun(true);
    expect(rows[220]).toMatchObject({ T: 71.2, Tss: 67.3, proj: 68.3, ttt: null, hr: 3500, band: "watch", pband: "nominal" });
    expect(rows[420]).toMatchObject({ T: 68.9, band: "nominal" });
    expect(crossed).toBeNull();
    expect(finalT).toBe(68);
    expect(band(finalT)).toBe("nominal");
  });

  it("the Sim engine reproduces the oracle B7 curve exactly", () => {
    // At the surge tick, current band is still nominal while the projection is already warn.
    const at120 = b7After(120);
    expect(at120.gpu_temp_c).toBe(62);
    expect(at120.projected_temp_5m).toBe(82.8);
    expect(at120.time_to_throttle_s).toBe(339);
    expect(at120.headroom_w).toBe(-1260);
    expect(at120.band).toBe("nominal");
    expect(band(at120.projected_temp_5m)).toBe("warn");

    expect(b7After(180)).toMatchObject({ gpu_temp_c: 68.7, projected_temp_5m: 84.5, time_to_throttle_s: 279, band: "nominal" });
    expect(b7After(200).band).toBe("watch");
    expect(b7After(340)).toMatchObject({ gpu_temp_c: 79.7, band: "warn" });
    expect(b7After(460)).toMatchObject({ gpu_temp_c: 84, band: "critical" });
  });

  it("projection leads the natural crossing by at least 240 s", () => {
    // Warn fires at the surge (t=120); the natural crossing is at t=460.
    const { crossed } = oracleRun(false);
    expect(crossed! - 120).toBeGreaterThanOrEqual(240);
    expect(b7After(120).projected_temp_5m).toBeGreaterThanOrEqual(79); // warn band at surge
    expect(b7After(120).gpu_temp_c).toBeLessThan(84); // but not throttling yet
  });
});

describe("action effects on temperature", () => {
  it("relieves the source to nominal even when the model omits cap_w (auto-cap on migrate)", () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(210);
    expect(sim.getRackStates().find((r) => r.id === "B7")!.power_draw_w).toBe(P1); // 12600 W at surge

    // A migrate with NO cap_w in params: the sim must still shed low-priority load to relieve B7.
    sim.applyAction(
      { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B15" }, one_line: "" },
      "adv-test",
    );

    const afterAction = sim.getRackStates().find((r) => r.id === "B7")!;
    expect(afterAction.power_draw_w).toBe(P1 - ACTION_REMOVE); // 7840 W: 1400 migrated + 3360 shed
    expect(afterAction.headroom_w).toBe(3500);

    sim.advance(300);
    const settled = sim.getRackStates().find((r) => r.id === "B7")!;
    expect(settled.band).toBe("nominal");
    expect(settled.projected_temp_5m).toBeLessThanOrEqual(69);
  });

  it("approved migrate + cap removes 4760 W and matches the oracle with-action curve", () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(210);
    const before = sim.getRackStates().find((r) => r.id === "B7")!;
    expect(before.power_draw_w).toBe(P1); // 12600 W right before the action

    sim.applyAction(
      { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B15", cap_w: 11340 }, one_line: "" },
      "adv-test",
    );

    const afterAction = sim.getRackStates().find((r) => r.id === "B7")!;
    expect(afterAction.power_draw_w).toBe(P1 - ACTION_REMOVE); // 7840 W (1400 migrated + 3360 shed)
    expect(afterAction.headroom_w).toBe(3500);

    sim.advance(10);
    const at220 = sim.getRackStates().find((r) => r.id === "B7")!;
    expect(at220.gpu_temp_c).toBe(71.2);
    expect(at220.projected_temp_5m).toBe(68.3);
    expect(at220.time_to_throttle_s).toBeNull();
    expect(at220.band).toBe("watch");
    expect(band(at220.projected_temp_5m)).toBe("nominal");
  });

  it("applying the action drops B7 projected temperature and restores positive headroom", () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(180);
    const before = sim.getRackStates().find((r) => r.id === "B7")!;
    expect(before.projected_temp_5m).toBeGreaterThan(84);
    expect(before.headroom_w).toBeLessThan(0);

    sim.applyAction(
      { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B15", cap_w: 11340 }, one_line: "" },
      "adv-test",
    );
    const after = sim.getRackStates().find((r) => r.id === "B7")!;
    expect(after.projected_temp_5m).toBeLessThan(before.projected_temp_5m);
    expect(after.headroom_w).toBeGreaterThan(0);
  });

  it("never crosses throttle once the action is applied", () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(210);
    sim.applyAction(
      { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B15", cap_w: 11340 }, one_line: "" },
      "adv-test",
    );
    for (let i = 0; i < 400; i++) {
      sim.advance(1);
      expect(sim.getRackStates().find((r) => r.id === "B7")!.gpu_temp_c).toBeLessThan(84);
    }
  });

  it("migration target B15 receives job-4471 and stays nominal", () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(210);
    sim.applyAction(
      { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B15", cap_w: 11340 }, one_line: "" },
      "adv-test",
    );
    sim.advance(200);
    const b15 = sim.getRackStates().find((r) => r.id === "B15")!;
    expect(b15.power_draw_w).toBe(6800); // 5400 baseline + 1400 migrated
    expect(b15.band).toBe("nominal");
    expect(b15.headroom_w).toBe(9400);
  });
});

describe("scheduler + world", () => {
  it("starts B7 nominal at ~62 C with negative-free headroom", () => {
    const b7 = b7After(0);
    expect(b7.gpu_temp_c).toBe(62);
    expect(b7.band).toBe("nominal");
    expect(b7.headroom_w).toBe(4620);
    expect(b7.power_draw_w).toBe(6720);
  });

  it("records the surge placement and keeps every other rack nominal at the surge tick", () => {
    const sim = new Sim();
    sim.start("S1");
    sim.advance(120);
    const states = sim.getRackStates();
    const atRisk = states.filter((s) => 84 - s.projected_temp_5m <= 15);
    expect(atRisk.map((s) => s.id)).toEqual(["B7"]);
    expect(sim.getQueue().recent_placements[0]).toMatchObject({ job_id: "job-4471", rack_id: "B7", ts: 120 });
  });

  it("is fully deterministic across runs and speeds", () => {
    const a = new Sim();
    a.start("S1");
    a.advance(300);
    const b = new Sim();
    b.start("S1");
    for (let i = 0; i < 300; i++) b.advance(1);
    expect(a.getRackStates()).toEqual(b.getRackStates());
  });
});
