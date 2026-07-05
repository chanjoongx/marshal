/**
 * Marshal domain model. Single source of truth for the GPU data center world.
 * Every value the agent reasons over and the UI renders is defined here as a zod
 * schema with an inferred TypeScript type. Numeric features (temperatures,
 * projections, headroom, time-to-throttle) are computed by CODE per docs/SIM_SPEC.md;
 * the LLM never does arithmetic. See docs/AGENT_SPEC.md for how these feed the agent.
 */
import { z } from "zod";

/**
 * Physical and policy constants. The formulas that consume them live in
 * docs/SIM_SPEC.md and scripts/curve_check.mjs (the oracle the sim engine must match).
 * GPU numbers are sourced from the NVIDIA H100 SXM5 datasheet and the data-center
 * thermal references cited in SIM_SPEC. Import these; do not retype the numbers.
 */
export const SIM = {
  GPUS_PER_RACK: 8,
  GPU_TDP_W: 700, // NVIDIA H100 SXM5 per-GPU TDP
  INLET_TEMP_C: 30, // cold-aisle / coolant inlet reference
  THROTTLE_TEMP_C: 84, // GPU throttle onset (H100 throttles in the low-to-mid 80s C)
  THERMAL_TAU_S: 220, // first-order thermal time constant, tuned via scripts/curve_check.mjs (see SIM_SPEC)
  RACK_POWER_BUDGET_W: 24000, // per-rack electrical ceiling (total rack power, all -> heat)
  PROJECTION_HORIZON_S: 300, // 5-minute predictive lookahead
  BAND_WATCH_MARGIN_C: 15, // projected margin to throttle: > 15 => nominal
  BAND_WARN_MARGIN_C: 5, // 5..15 => watch, 0..5 => warn, <= 0 => critical
  DEBOUNCE_S: 20, // minimum sim-seconds between advisories for one rack
  TICK_S: 1, // 1 sim-second per tick at 1x
} as const;

export const SimSpeedSchema = z.union([z.literal(1), z.literal(4), z.literal(8)]);
export type SimSpeed = z.infer<typeof SimSpeedSchema>;

export const ScenarioIdSchema = z.enum(["idle", "S1", "S2"]);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

export const ThermalBandSchema = z.enum(["nominal", "watch", "warn", "critical"]);
export type ThermalBand = z.infer<typeof ThermalBandSchema>;

export const JobPrioritySchema = z.enum(["low", "normal", "high"]);
export type JobPriority = z.infer<typeof JobPrioritySchema>;

export const JobSchema = z.object({
  id: z.string(), // "job-4471"
  priority: JobPrioritySchema,
  power_w: z.number(), // heat contribution while running
  sla: z.string(), // human label, e.g. "batch inference, 2h window"
  dependencies: z.array(z.string()).optional(),
  // A job that must run on the same rack as this one (gradient/data exchange). Moving this job
  // away from its partner severely degrades it, so the migration target must host the partner.
  co_located_with: z.string().optional(),
});
export type Job = z.infer<typeof JobSchema>;

/** Internal sim entity: topology + config + raw integrated telemetry. */
export const RackSchema = z.object({
  id: z.string(), // "B7"
  row: z.string(), // "B"
  position: z.number().int(), // 7
  gpus: z.number().int(),
  cooling_capacity_w: z.number(), // heat-removal conductance reference (see SIM_SPEC)
  power_budget_w: z.number(),
  power_draw_w: z.number(), // total rack electrical power (node + top-of-rack infra + conversion losses), ~= heat input
  utilization_pct: z.number(),
  gpu_temp_c: z.number(), // representative GPU temperature (lumped rack thermal state, heatsink + coolant dominated)
  inlet_temp_c: z.number(),
  active_jobs: z.array(JobSchema),
});
export type Rack = z.infer<typeof RackSchema>;

/** Published, derived per-rack view. Every derived field is CODE-computed. */
export const RackStateSchema = z.object({
  id: z.string(),
  row: z.string(),
  position: z.number().int(),
  gpu_temp_c: z.number(),
  projected_temp_5m: z.number(), // first-order projection, SIM_SPEC
  time_to_throttle_s: z.number().nullable(), // null if not heading to throttle
  headroom_w: z.number(), // extra heat power before steady-state hits throttle
  band: ThermalBandSchema,
  utilization_pct: z.number(),
  power_draw_w: z.number(),
  power_budget_w: z.number().optional(), // electrical ceiling; a migrate target must stay under it
  active_jobs: z.array(JobSchema),
});
export type RackState = z.infer<typeof RackStateSchema>;

export const QueuedJobSchema = JobSchema.extend({
  target_hint: z.string().optional(), // rack the scheduler intends to place on
});
export type QueuedJob = z.infer<typeof QueuedJobSchema>;

export const SchedulerQueueSchema = z.object({
  pending: z.array(QueuedJobSchema),
  recent_placements: z.array(
    z.object({ job_id: z.string(), rack_id: z.string(), ts: z.number() }),
  ),
});
export type SchedulerQueue = z.infer<typeof SchedulerQueueSchema>;

/**
 * Operator-added constraint. A structured object, not a text note. Injected into
 * every future snapshot so the agent reconciles it into subsequent advisories.
 */
export const ConstraintKindSchema = z.enum([
  "exclude_rack", // never migrate onto target rack
  "avoid_row", // deprioritize a whole row
  "cap_rack_intake", // hold a rack intake at/under a cap
  "prefer_rack", // prefer target rack when feasible
  "pin_job", // do not move target job
]);
export type ConstraintKind = z.infer<typeof ConstraintKindSchema>;

export const ConstraintSchema = z.object({
  id: z.string(),
  kind: ConstraintKindSchema,
  target: z.string(), // rack id, row, or job id per kind
  reason: z.string(), // operator words, e.g. "B3 has a firmware update in 10 min"
  ts: z.number(), // sim-time seconds when added
  source: z.enum(["override", "operator"]),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const ActionTypeSchema = z.enum([
  "migrate_job",
  "power_cap", // non-destructive DVFS: clamp a rack's power/clock, shed nothing (cap_w = ceiling W)
  "cap_intake",
  "rebalance_row",
  "hold",
  "no_action",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ActionParamsSchema = z.object({
  job_id: z.string().optional(),
  from_rack: z.string().optional(),
  to_rack: z.string().optional(),
  cap_w: z.number().optional(),
  row: z.string().optional(),
});
export type ActionParams = z.infer<typeof ActionParamsSchema>;

export const ActionSchema = z.object({
  type: ActionTypeSchema,
  params: ActionParamsSchema,
  one_line: z.string(), // executable instruction, <= ~90 chars
});
export type Action = z.infer<typeof ActionSchema>;

export const SeveritySchema = z.enum(["watch", "warn", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * The agent's output. `rationale` must cite at least two snapshot numbers.
 * `action` must satisfy all active constraints and be physically executable
 * (target rack has headroom and stays within power budget); this is validated by
 * CODE before the advisory is surfaced (see AGENT_SPEC action-feasibility loop).
 */
export const AdvisorySchema = z.object({
  id: z.string(),
  ts: z.number(),
  severity: SeveritySchema,
  area: z.string(), // "B7" or "row B"
  headline: z.string().max(90),
  rationale: z.string(), // 2 sentences, cites >= 2 snapshot numbers
  action: ActionSchema,
  alternatives: z.array(ActionSchema).max(2),
  confidence: z.number().min(0).max(1),
  learned_from: z.string().nullable(), // constraint id if this reflects a learned rule
  origin: z.enum(["model", "auto", "mock"]), // model = live Nemotron; auto = rule fallback; mock = offline canned
  latency_ms: z.number().optional(), // wall-clock of the live model call; set by the Crusoe provider only
  // What a naive headroom-only rule would have done, when it differs from the model's choice
  // and would be wrong (e.g. breaks a co-location). Code-computed, for the "why not rules" contrast.
  rule_pick: z
    .object({ to_rack: z.string(), one_line: z.string(), flaw: z.string() })
    .optional(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

export const AdvisoryOutcomeSchema = z.enum([
  "pending",
  "approved",
  "overridden",
  "dismissed",
  "auto_expired",
]);
export type AdvisoryOutcome = z.infer<typeof AdvisoryOutcomeSchema>;

export const AdvisoryRecordSchema = z.object({
  advisory: AdvisorySchema,
  outcome: AdvisoryOutcomeSchema,
  operator_reason: z.string().optional(),
  resolved_ts: z.number().optional(),
});
export type AdvisoryRecord = z.infer<typeof AdvisoryRecordSchema>;

/** An approved action's ongoing effect on the sim (what actually bends the curve). */
export const EffectTypeSchema = z.enum(["job_migrated", "intake_capped", "power_capped", "row_rebalanced"]);
export type EffectType = z.infer<typeof EffectTypeSchema>;

export const ActiveEffectSchema = z.object({
  id: z.string(),
  type: EffectTypeSchema,
  applied_ts: z.number(),
  advisory_id: z.string(),
  params: ActionParamsSchema,
});
export type ActiveEffect = z.infer<typeof ActiveEffectSchema>;

export const ClusterSummarySchema = z.object({
  racks_total: z.number().int(),
  racks_watch: z.number().int(),
  racks_warn: z.number().int(),
  racks_critical: z.number().int(),
  hottest_rack_id: z.string(),
  note: z.string(), // "cluster nominal, B-row utilization climbing"
});
export type ClusterSummary = z.infer<typeof ClusterSummarySchema>;

/** Full published world, sent to clients on every tick. */
export const WorldStateSchema = z.object({
  scenario: ScenarioIdSchema,
  sim_time_s: z.number(),
  speed: SimSpeedSchema,
  running: z.boolean(),
  cluster_summary: ClusterSummarySchema,
  racks: z.array(RackStateSchema),
  queue: SchedulerQueueSchema,
  constraints: z.array(ConstraintSchema),
  effects: z.array(ActiveEffectSchema),
  advisories_recent: z.array(AdvisoryRecordSchema),
});
export type WorldState = z.infer<typeof WorldStateSchema>;

/**
 * Snapshot handed to the inference provider. Compact by design: target < ~1400
 * tokens (see AGENT_SPEC). `racks` may be the at-risk subset, not all 24. The
 * `constraints` array is what makes reconciliation the LLM's real job.
 */
export const SnapshotTriggerSchema = z.enum(["band_cross", "override", "why", "resolution"]);
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;

export const SnapshotSchema = z.object({
  sim_time_s: z.number(),
  cluster_note: z.string(),
  racks: z.array(RackStateSchema),
  queue: SchedulerQueueSchema,
  constraints: z.array(ConstraintSchema),
  recent_advisories: z.array(AdvisoryRecordSchema).max(3),
  focus_rack_id: z.string().optional(),
  trigger: SnapshotTriggerSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Fast-tier (DeepSeek) output: which at-risk racks warrant a heavy-tier advisory. */
export const RiskClassSchema = z.enum(["nominal", "elevated", "at_risk"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const RiskClassificationSchema = z.object({
  rack_id: z.string(),
  risk: RiskClassSchema,
});
export type RiskClassification = z.infer<typeof RiskClassificationSchema>;

export const ResolutionSchema = z.object({
  id: z.string(),
  ts: z.number(),
  area: z.string(),
  summary: z.string(),
  timeline: z.array(z.object({ ts: z.number(), label: z.string() })),
  advisories: z.array(z.string()), // advisory ids involved
  learned_constraints: z.array(z.string()), // constraint ids created during incident
});
export type Resolution = z.infer<typeof ResolutionSchema>;
