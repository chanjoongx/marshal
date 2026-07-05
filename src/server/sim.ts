/**
 * Deterministic, seeded thermal engine + scheduler for Marshal (docs/SIM_SPEC.md).
 *
 * The physical world the agent watches: a 24-rack GPU pod with a first-order lumped
 * capacitance thermal model. Every number here is CODE; the LLM does no arithmetic.
 * The pure thermal functions mirror scripts/curve_check.mjs exactly (the oracle the sim
 * must match) and consume the SIM constants from src/shared/types.ts. No wall-clock is used;
 * state is a function of an integer sim_time counter, and the only randomness is a seeded
 * mulberry32 used for cosmetic inlet jitter (+/-0.2 C), never for core dynamics.
 */
import { SIM } from "../shared/types";
import type {
  Job,
  QueuedJob,
  RackState,
  ThermalBand,
  ActiveEffect,
  Action,
  SchedulerQueue,
  ClusterSummary,
  ScenarioId,
} from "../shared/types";

/** Reference delta-T that defines cooling_capacity_w: throttle onset above inlet. */
export const DREF = SIM.THROTTLE_TEMP_C - SIM.INLET_TEMP_C; // 54

/* ------------------------------- thermal model ------------------------------- */
// These five functions are the executable contract with scripts/curve_check.mjs.

/** Temperature a rack settles to at heat power P (W) given its cooling capacity (W). */
export function steadyState(power: number, capacity: number): number {
  return SIM.INLET_TEMP_C + (DREF * power) / capacity;
}

/** Exact first-order update over dt sim-seconds. Stable for any step size. */
export function stepTemp(temp: number, steady: number, dt: number): number {
  return steady + (temp - steady) * Math.exp(-dt / SIM.THERMAL_TAU_S);
}

/** 5-minute lookahead using the same exact-exponential form. */
export function projectTemp(temp: number, steady: number): number {
  return steady + (temp - steady) * Math.exp(-SIM.PROJECTION_HORIZON_S / SIM.THERMAL_TAU_S);
}

/** Seconds until the rack crosses throttle, or null if it is not heading there. */
export function timeToThrottle(temp: number, steady: number): number | null {
  if (temp >= SIM.THROTTLE_TEMP_C) return 0;
  if (steady <= SIM.THROTTLE_TEMP_C) return null;
  return SIM.THERMAL_TAU_S * Math.log((steady - temp) / (steady - SIM.THROTTLE_TEMP_C));
}

/** Extra heat power the rack can take before its steady state reaches throttle. */
export function headroomW(power: number, capacity: number): number {
  return capacity - power;
}

/** Band from a temperature, on margin m = throttle - temp (docs/SIM_SPEC.md section 3). */
export function band(temp: number): ThermalBand {
  const m = SIM.THROTTLE_TEMP_C - temp;
  if (m <= 0) return "critical";
  if (m <= SIM.BAND_WARN_MARGIN_C) return "warn";
  if (m <= SIM.BAND_WATCH_MARGIN_C) return "watch";
  return "nominal";
}

/** Deterministic PRNG (mulberry32). Seeded once; used only for cosmetic inlet jitter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ----------------------------------- topology -------------------------------- */

const HEALTHY_CAP = 16200; // 300 W/C conductance, ~16 kW heat removal at the throttle delta-T
const B7_CAP = 11340; // 210 W/C: the marginal-cooling hero rack (restricted airflow), ~11 kW

interface SimRack {
  id: string;
  row: string;
  position: number;
  cap: number;
  temp: number; // current rack package temperature (heatsink + coolant thermal mass, tau ~220s)
  jobs: Job[]; // power_draw_w == sum of job power_w (total rack electrical power, all -> heat)
  inlet: number; // cosmetic, seeded jitter around INLET_TEMP_C
  dvfsCapW: number | null; // non-destructive DVFS power ceiling (null = full clock, sheds nothing)
}

const PRIORITY_RANK = { low: 0, normal: 1, high: 2 } as const;

function job(id: string, priority: Job["priority"], power_w: number, sla: string): Job {
  return { id, priority, power_w, sla };
}

function rackDraw(r: SimRack): number {
  let sum = 0;
  for (const j of r.jobs) sum += j.power_w;
  return sum;
}

/** Power actually drawn, and turned to heat, after any DVFS clock cap. A power_cap clamps this
 *  ceiling without evicting jobs; they keep running at a lower clock. */
function effectivePower(r: SimRack): number {
  const raw = rackDraw(r);
  return r.dvfsCapW == null ? raw : Math.min(raw, r.dvfsCapW);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/* ------------------------------------ engine --------------------------------- */

export class Sim {
  scenario: ScenarioId = "idle";
  simTime = 0;
  speed: 1 | 4 | 8 = 1;
  running = false;

  private racks: SimRack[] = [];
  private byId = new Map<string, SimRack>();
  private fired = new Set<string>();
  private placements: { job_id: string; rack_id: string; ts: number }[] = [];
  private pending: QueuedJob[] = [];
  effects: ActiveEffect[] = [];

  constructor() {
    this.build();
  }

  /** Reset the world to a scenario's t=0 state. Deterministic and repeatable. */
  start(scenario: ScenarioId): void {
    this.scenario = scenario;
    this.simTime = 0;
    this.fired.clear();
    this.placements = [];
    this.pending = [];
    this.effects = [];
    this.build();
    this.running = scenario !== "idle";
  }

  reset(): void {
    this.start("idle");
    this.running = false;
  }

  setSpeed(speed: 1 | 4 | 8): void {
    this.speed = speed;
  }

  private build(): void {
    const rng = mulberry32(0x4d41); // "MA"
    const racks: SimRack[] = [];
    const mk = (row: string, pos: number, cap: number, jobs: Job[]): SimRack => {
      const inlet = SIM.INLET_TEMP_C + (rng() * 2 - 1) * 0.2; // +/-0.2 C cosmetic jitter
      return { id: `${row}${pos}`, row, position: pos, cap, temp: 0, jobs, inlet, dvfsCapW: null };
    };

    // Aisle B: main GPU compute, B1..B15. B7 is the marginal-cooling hero rack.
    for (let p = 1; p <= 15; p++) {
      let cap = HEALTHY_CAP;
      let jobs: Job[];
      if (p === 7) {
        cap = B7_CAP;
        jobs = [job("job-7001", "normal", 6720, "resnet-152 training, steady")];
      } else if (p === 3) {
        // B3 hosts job-4470, the gradient partner that job-4471 must co-locate with. It runs
        // moderately loaded (headroom 6200 W, less than the emptiest racks) so a headroom-only
        // rule would never pick it, which is what makes the co-location the model's real job.
        jobs = [
          job("job-4470", "high", 1800, "resnet training, gradient partner"),
          job("ckpt-9", "low", 1600, "checkpoint writer"),
          job("b3-svc", "normal", 6600, "inference service"),
        ];
      } else if (p === 12) {
        jobs = [job("job-b12", "normal", 6000, "inference service, low load")];
      } else if (p === 14) {
        jobs = [job("job-b14", "normal", 5700, "inference service, low load")];
      } else if (p === 15) {
        jobs = [job("job-b15", "normal", 5400, "inference service, low load")];
      } else {
        jobs = [job(`job-b${p}`, "normal", 9200 + ((p * 120) % 600), "training shard")];
      }
      racks.push(mk("B", p, cap, jobs));
    }

    // Aisle A: mixed aisle, A1..A9. A5 takes the second-event surge.
    for (let p = 1; p <= 9; p++) {
      const jobs =
        p === 5
          ? [job("job-a5", "normal", 8400, "batch inference, steady")]
          : [job(`job-a${p}`, "normal", 8600 + ((p * 140) % 560), "batch inference")];
      racks.push(mk("A", p, HEALTHY_CAP, jobs));
    }

    for (const r of racks) r.temp = steadyState(effectivePower(r), r.cap);

    this.racks = racks;
    this.byId = new Map(racks.map((r) => [r.id, r]));
  }

  rack(id: string): SimRack | undefined {
    return this.byId.get(id);
  }

  /** Advance one whole sim-second: step temperature, then apply scripted events. */
  private advanceOneSecond(): void {
    for (const r of this.racks) {
      const steady = steadyState(effectivePower(r), r.cap);
      r.temp = stepTemp(r.temp, steady, SIM.TICK_S);
    }
    this.simTime += 1;
    this.applyEvents(this.simTime);
  }

  /** Advance the sim by `seconds` 1-second sub-steps (keeps 1x/4x/8x identical). */
  advance(seconds: number): void {
    for (let i = 0; i < seconds; i++) this.advanceOneSecond();
  }

  private applyEvents(t: number): void {
    if (this.scenario !== "S1") return;

    // Batch surge on B-row: B7's draw goes 6720 -> 12600, headroom +4620 -> -1260.
    if (t === 120 && !this.fired.has("surge")) {
      this.fired.add("surge");
      const b7 = this.rack("B7");
      if (b7) {
        b7.jobs.push({
          ...job("job-4471", "high", 1400, "distributed training, gradient exchange"),
          co_located_with: "job-4470",
        });
        for (let i = 1; i <= 4; i++) b7.jobs.push(job(`batch-${i}`, "low", 1120, "batch training"));
      }
      this.placements.unshift({ job_id: "job-4471", rack_id: "B7", ts: t });
      this.pending = [{ ...job("job-5540", "low", 1120, "batch training"), target_hint: "B-row" }];
    }

    // Second event: A-row spikes after B7 is resolved (drives the learning advisory).
    if (t === 300 && !this.fired.has("arow")) {
      this.fired.add("arow");
      const a5 = this.rack("A5");
      if (a5) {
        a5.jobs.push({
          ...job("job-4820", "high", 1400, "distributed training, gradient exchange"),
          co_located_with: "job-4470",
        });
        for (let i = 1; i <= 6; i++) a5.jobs.push(job(`abatch-${i}`, "low", 1400, "batch training"));
      }
      this.placements.unshift({ job_id: "job-4820", rack_id: "A5", ts: t });
    }
  }

  /* --------------------------------- effects --------------------------------- */

  /** Apply an approved action as an effect that mutates sim heat power. */
  applyAction(action: Action, advisoryId: string): ActiveEffect[] {
    const out: ActiveEffect[] = [];
    if (action.type === "migrate_job") {
      const { job_id, from_rack, to_rack, cap_w } = action.params;
      if (job_id && from_rack && to_rack) {
        const e = this.migrate(job_id, from_rack, to_rack, advisoryId);
        if (e) out.push(e);
      }
      // A migrate off an over-capacity rack must also relieve it. The real model names the cap
      // in one_line but often omits the cap_w param, so always cap the source (SIM_SPEC section 6).
      // cap() sheds only low-priority jobs and only until the projected margin clears nominal, so
      // it is a no-op when the source is not over capacity.
      if (from_rack) {
        const src = this.rack(from_rack);
        if (src) out.push(...this.cap(from_rack, cap_w ?? src.cap, advisoryId));
      }
    } else if (action.type === "cap_intake") {
      const rackId = action.params.from_rack ?? action.params.to_rack;
      const capW = action.params.cap_w ?? (rackId ? this.rack(rackId)?.cap ?? 0 : 0);
      if (rackId) out.push(...this.cap(rackId, capW, advisoryId));
    } else if (action.type === "power_cap") {
      const rackId = action.params.from_rack ?? action.params.to_rack;
      if (rackId) out.push(...this.powerCap(rackId, action.params.cap_w, advisoryId));
    } else if (action.type === "rebalance_row" && action.params.row) {
      const hottest = this.racks
        .filter((r) => r.row === action.params.row)
        .sort((a, b) => b.temp - a.temp)[0];
      if (hottest) out.push(...this.cap(hottest.id, hottest.cap, advisoryId));
    }
    this.effects.push(...out);
    return out;
  }

  private migrate(jobId: string, from: string, to: string, advisoryId: string): ActiveEffect | null {
    const f = this.rack(from);
    const t = this.rack(to);
    if (!f || !t) return null;
    const idx = f.jobs.findIndex((j) => j.id === jobId);
    if (idx < 0) return null;
    const [moved] = f.jobs.splice(idx, 1);
    t.jobs.push(moved);
    this.placements.unshift({ job_id: jobId, rack_id: to, ts: this.simTime });
    return {
      id: `eff-mig-${jobId}-${Math.round(this.simTime)}`,
      type: "job_migrated",
      applied_ts: this.simTime,
      advisory_id: advisoryId,
      params: { job_id: jobId, from_rack: from, to_rack: to },
    };
  }

  /**
   * Cap a rack's intake: shed its lowest-priority jobs one at a time until its projected
   * margin returns above the nominal threshold. Never sheds high-priority jobs.
   */
  private cap(rackId: string, capW: number, advisoryId: string): ActiveEffect[] {
    const r = this.rack(rackId);
    if (!r) return [];
    while (true) {
      const steady = steadyState(effectivePower(r), r.cap);
      const proj = projectTemp(r.temp, steady);
      if (SIM.THROTTLE_TEMP_C - proj > SIM.BAND_WATCH_MARGIN_C) break;
      const sheddable = r.jobs
        .filter((j) => j.priority !== "high")
        .sort(
          (a, b) =>
            PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
            a.power_w - b.power_w ||
            (a.id < b.id ? -1 : 1),
        );
      const victim = sheddable[0];
      if (!victim) break;
      r.jobs.splice(r.jobs.indexOf(victim), 1);
    }
    return [
      {
        id: `eff-cap-${rackId}-${Math.round(this.simTime)}`,
        type: "intake_capped",
        applied_ts: this.simTime,
        advisory_id: advisoryId,
        params: { from_rack: rackId, cap_w: capW },
      },
    ];
  }

  /**
   * Non-destructive DVFS power cap: clamp the rack's effective power to `capW` (or a computed level
   * that clears the nominal margin), evicting nothing. Jobs keep running at a lower clock, the least
   * disruptive way to hold a rack under throttle for an imminent risk.
   */
  private powerCap(rackId: string, capW: number | undefined, advisoryId: string): ActiveEffect[] {
    const r = this.rack(rackId);
    if (!r) return [];
    // Clamp to a level that keeps the projection nominal; honor a tighter operator cap_w if given,
    // but never accept a looser one (the model sometimes suggests exactly the cooling capacity,
    // which only holds at the throttle line). Guarantees the curve bends back to nominal.
    r.dvfsCapW = Math.min(capW ?? Infinity, this.safeDvfsLevel(r));
    return [
      {
        id: `eff-pcap-${rackId}-${Math.round(this.simTime)}`,
        type: "power_capped",
        applied_ts: this.simTime,
        advisory_id: advisoryId,
        params: { from_rack: rackId, cap_w: r.dvfsCapW },
      },
    ];
  }

  /** The lightest clock cap (highest effective power) that keeps the rack's projection nominal. */
  private safeDvfsLevel(r: SimRack): number {
    let level = rackDraw(r);
    while (level > 200) {
      const proj = projectTemp(r.temp, steadyState(level, r.cap));
      if (SIM.THROTTLE_TEMP_C - proj > SIM.BAND_WATCH_MARGIN_C) break;
      level -= 200;
    }
    return level;
  }

  /* --------------------------------- published ------------------------------- */

  private toRackState(r: SimRack): RackState {
    const power = effectivePower(r);
    const steady = steadyState(power, r.cap);
    const ttt = timeToThrottle(r.temp, steady);
    return {
      id: r.id,
      row: r.row,
      position: r.position,
      gpu_temp_c: round1(r.temp),
      projected_temp_5m: round1(projectTemp(r.temp, steady)),
      time_to_throttle_s: ttt === null ? null : Math.round(ttt),
      headroom_w: Math.round(headroomW(power, r.cap)),
      band: band(r.temp),
      utilization_pct: Math.round((100 * power) / r.cap), // cooling load: draw as a % of heat-removal capacity
      power_draw_w: Math.round(power),
      power_budget_w: SIM.RACK_POWER_BUDGET_W,
      active_jobs: r.jobs,
    };
  }

  getRackStates(): RackState[] {
    return this.racks.map((r) => this.toRackState(r));
  }

  getQueue(): SchedulerQueue {
    return { pending: this.pending, recent_placements: this.placements.slice(0, 6) };
  }

  clusterNote(states: RackState[]): string {
    const critical = states.filter((s) => s.band === "critical").length;
    const hot = states.filter((s) => s.band === "warn" || s.band === "watch");
    if (critical > 0) return "B-row batch surge, a rack is over its cooling capacity";
    if (hot.some((s) => s.row === "A")) return "A-row utilization spiking";
    if (hot.length > 0) return "B-row utilization climbing, one rack heating";
    return "cluster nominal, B-row utilization climbing";
  }

  clusterSummary(states: RackState[]): ClusterSummary {
    const hottest = [...states].sort((a, b) => b.gpu_temp_c - a.gpu_temp_c)[0];
    return {
      racks_total: states.length,
      racks_watch: states.filter((s) => s.band === "watch").length,
      racks_warn: states.filter((s) => s.band === "warn").length,
      racks_critical: states.filter((s) => s.band === "critical").length,
      hottest_rack_id: hottest?.id ?? "none",
      note: this.clusterNote(states),
    };
  }
}
