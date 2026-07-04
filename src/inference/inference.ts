/**
 * Marshal inference layer. One `Provider` interface, two implementations:
 *
 *  - MockProvider    deterministic canned outputs keyed to S1 sim stages. Active when
 *                    MOCK=1 or no API key. Lets the whole app build and the smoke test run
 *                    with no network.
 *  - CrusoeProvider  real Crusoe Managed Inference over OpenAI-compatible HTTP. Nemotron
 *                    Ultra for advisories/Why, DeepSeek Flash for risk classification.
 *                    Request shape follows docs/CRUSOE_NOTES.md; scripts/probe.mjs confirms
 *                    the response_format and thinking flags before we trust it for the demo.
 *
 * The feasibility check (validateAction) and the deterministic fallback (ruleBasedAdvisory)
 * are pure functions the agent loop (src/server) and tests/smoke.spec.ts both use. See
 * docs/AGENT_SPEC.md for how these compose into the two validation loops.
 */
import { z } from "zod";
import {
  SIM,
  AdvisorySchema,
  RiskClassificationSchema,
  type Advisory,
  type Action,
  type ConstraintKind,
  type Job,
  type RackState,
  type RiskClassification,
  type Snapshot,
} from "../shared/types";

/* ------------------------------- config / env -------------------------------- */

export interface InferenceEnv {
  CRUSOE_API_KEY?: string;
  CRUSOE_BASE_URL?: string; // default: exact endpoint, no trailing slash
  MODEL_ADVISORY?: string; // default: nvidia/NVIDIA-Nemotron-3-Ultra-550B
  MODEL_CLASSIFY?: string; // default: deepseek-ai/Deepseek-V4-Flash
  MOCK?: string;
}

const DEFAULTS = {
  CRUSOE_BASE_URL: "https://api.inference.crusoecloud.com/v1",
  MODEL_ADVISORY: "nvidia/NVIDIA-Nemotron-3-Ultra-550B",
  MODEL_CLASSIFY: "deepseek-ai/Deepseek-V4-Flash",
} as const;

export interface Provider {
  /** Fast tier: classify each at-risk rack in the snapshot. */
  classifyRisk(snapshot: Snapshot): Promise<RiskClassification[]>;
  /** Heavy tier: one structured advisory for the focus rack. `feedback` carries a zod or
   *  feasibility error for a re-prompt (see AGENT_SPEC validation loops). */
  advise(snapshot: Snapshot, feedback?: string): Promise<Advisory>;
  /** Heavy tier: <= 3 sentences justifying an advisory with snapshot numbers, no new advice. */
  why(snapshot: Snapshot, advisoryId: string): Promise<string>;
  /** Interpret a shift engineer's free-text override note into one structured constraint, or
   *  null if nothing actionable is found. This is the load-bearing natural-language step. */
  interpretConstraint(text: string, snapshot: Snapshot): Promise<InterpretedConstraint | null>;
}

export interface InterpretedConstraint {
  kind: ConstraintKind;
  target: string;
  reason: string;
}

export function getProvider(env: InferenceEnv): Provider {
  if (env.MOCK === "1" || !env.CRUSOE_API_KEY) return new MockProvider();
  return new CrusoeProvider(env);
}

/* --------------------------- shared pure helpers ----------------------------- */

/** The model returns everything except the code-filled id/ts/origin/rule_pick. */
export const AdvisoryDraftSchema = AdvisorySchema.omit({ id: true, ts: true, origin: true, rule_pick: true, latency_ms: true });
export type AdvisoryDraft = z.infer<typeof AdvisoryDraftSchema>;

export const ClassifyResponseSchema = z.object({
  classifications: z.array(RiskClassificationSchema),
});

/** Look up a job by id across the snapshot's racks and pending queue. */
export function findJob(snapshot: Snapshot, jobId: string): Job | undefined {
  for (const r of snapshot.racks) {
    const j = r.active_jobs.find((j) => j.id === jobId);
    if (j) return j;
  }
  return snapshot.queue.pending.find((j) => j.id === jobId);
}

/**
 * Action-feasibility validation (AGENT_SPEC 4b). Pure: given a proposed action and the
 * snapshot, decide whether it satisfies every active constraint and is physically executable.
 * Only migrate_job has physical preconditions; the others are structurally valid if their
 * referenced racks exist.
 */
export function validateAction(
  action: Action,
  snapshot: Snapshot,
): { ok: true } | { ok: false; reason: string } {
  if (action.type !== "migrate_job") return { ok: true };

  const jobId = action.params.job_id;
  const toRack = action.params.to_rack;
  if (!jobId || !toRack) return { ok: false, reason: "migrate_job requires job_id and to_rack" };

  const target = snapshot.racks.find((r) => r.id === toRack);
  if (!target) return { ok: false, reason: `target ${toRack} not in snapshot` };

  const job = findJob(snapshot, jobId);
  if (!job) return { ok: false, reason: `job ${jobId} not found in snapshot` };

  for (const c of snapshot.constraints) {
    if (c.kind === "exclude_rack" && c.target === toRack)
      return { ok: false, reason: `target ${toRack} excluded: ${c.reason}` };
    if (c.kind === "avoid_row" && c.target === target.row)
      return { ok: false, reason: `row ${target.row} avoided: ${c.reason}` };
    if (c.kind === "pin_job" && c.target === jobId)
      return { ok: false, reason: `job ${jobId} pinned: ${c.reason}` };
  }

  if (target.headroom_w < job.power_w)
    return { ok: false, reason: `target ${toRack} headroom ${target.headroom_w}W < job ${job.power_w}W` };
  if (target.power_draw_w + job.power_w > (target.power_budget_w ?? SIM.RACK_POWER_BUDGET_W))
    return { ok: false, reason: `target ${toRack} would exceed power budget ${target.power_budget_w ?? SIM.RACK_POWER_BUDGET_W}W` };

  // Co-location: the job must land on the rack hosting its partner, unless that rack is excluded.
  if (job.co_located_with) {
    const partnerRack = snapshot.racks.find((r) => r.active_jobs.some((j) => j.id === job.co_located_with));
    const partnerExcluded =
      !!partnerRack && snapshot.constraints.some((c) => c.kind === "exclude_rack" && c.target === partnerRack.id);
    if (partnerRack && !partnerExcluded && toRack !== partnerRack.id)
      return { ok: false, reason: `breaks co-location: ${jobId} must run with ${job.co_located_with} on ${partnerRack.id}` };
  }

  return { ok: true };
}

/**
 * What a naive headroom-only rule would pick, ignoring co-location. Used to show the
 * "why not just rules" contrast: the greedy rule grabs the emptiest rack; the model reasons
 * about the co-location dependency the rule ignores.
 */
export function naiveHeadroomPick(
  snapshot: Snapshot,
  focusId: string,
  job: Job | undefined,
): { rack: RackState; breaksColo: boolean } | null {
  if (!job) return null;
  const target = snapshot.racks
    .filter((r) => r.id !== focusId)
    .filter((r) => !snapshot.constraints.some((c) => c.kind === "exclude_rack" && c.target === r.id))
    .filter((r) => r.headroom_w >= job.power_w)
    .sort((a, b) => b.headroom_w - a.headroom_w)[0];
  if (!target) return null;
  const breaksColo = !!job.co_located_with && !target.active_jobs.some((j) => j.id === job.co_located_with);
  return { rack: target, breaksColo };
}

/**
 * Deterministic, always-feasible fallback advisory (AGENT_SPEC 4c). Used when the model
 * fails schema or feasibility after retries, so the agent never goes silent. Marked
 * origin "auto" for honesty.
 */
export function ruleBasedAdvisory(snapshot: Snapshot): Advisory {
  const focusId = snapshot.focus_rack_id ?? hottest(snapshot)?.id ?? "cluster";
  const focus = snapshot.racks.find((r) => r.id === focusId);
  const excludeConstraint = snapshot.constraints.find((c) => c.kind === "exclude_rack");

  const job = focus ? highestPowerJob(focus.active_jobs) : undefined;
  const candidates = snapshot.racks
    .filter((r) => r.id !== focusId)
    .filter((r) =>
      job
        ? validateAction(
            { type: "migrate_job", params: { job_id: job.id, from_rack: focusId, to_rack: r.id }, one_line: "" },
            snapshot,
          ).ok
        : false,
    )
    .sort((a, b) => b.headroom_w - a.headroom_w);

  const target = candidates[0];
  const base = {
    id: `adv-auto-${Math.round(snapshot.sim_time_s)}-${focusId}`,
    ts: snapshot.sim_time_s,
    origin: "auto" as const,
    confidence: 0.5,
    learned_from: excludeConstraint ? excludeConstraint.id : null,
  };

  if (focus && job && target) {
    return {
      ...base,
      severity: focus.band === "critical" ? "critical" : "warn",
      area: focusId,
      headline: `Fallback: relieve ${focusId}, migrate ${job.id} to ${target.id}`,
      rationale: `${focusId} is at ${round(focus.gpu_temp_c)}C with headroom ${Math.round(focus.headroom_w)}W. ${target.id} has ${Math.round(target.headroom_w)}W headroom for job ${job.id} (${job.power_w}W).`,
      action: {
        type: "migrate_job",
        params: { job_id: job.id, from_rack: focusId, to_rack: target.id },
        one_line: `Migrate ${job.id} to ${target.id} and cap ${focusId} intake`,
      },
      alternatives: [{ type: "cap_intake", params: { from_rack: focusId }, one_line: `Cap ${focusId} intake, shed low-priority jobs` }],
    };
  }

  return {
    ...base,
    severity: "warn",
    area: focusId,
    headline: `Fallback: hold, no feasible target for ${focusId}`,
    rationale: `${focus ? `${focusId} is at ${round(focus.gpu_temp_c)}C with headroom ${Math.round(focus.headroom_w)}W.` : `${focusId} needs attention.`} No constraint-satisfying rack has enough headroom to receive its load.`,
    action: { type: "hold", params: {}, one_line: `Hold ${focusId}, escalate: no feasible migration target` },
    alternatives: [],
  };
}

function hottest(snapshot: Snapshot) {
  return [...snapshot.racks].sort((a, b) => b.gpu_temp_c - a.gpu_temp_c)[0];
}
function highestPowerJob(jobs: Job[]): Job | undefined {
  const rank = { high: 3, normal: 2, low: 1 } as const;
  return [...jobs].sort((a, b) => rank[b.priority] - rank[a.priority] || b.power_w - a.power_w)[0];
}
function round(n: number) {
  return Math.round(n * 10) / 10;
}

/**
 * Render the compact snapshot text sent to the heavy model (AGENT_SPEC section 2).
 * Deterministic ordering so prompt caching stays warm and MockProvider stays reproducible.
 */
export function renderSnapshot(snapshot: Snapshot): string {
  const lines: string[] = [];
  lines.push(`SNAPSHOT t=${Math.round(snapshot.sim_time_s)}s`);
  lines.push(`CLUSTER: ${snapshot.cluster_note}`);
  lines.push(`FOCUS: ${snapshot.focus_rack_id ?? "none"}   TRIGGER: ${snapshot.trigger}`);
  lines.push("RACKS:");
  lines.push("  headroom_w = cooling capacity minus draw (negative = over cooling capacity, heading to throttle); budget_w = separate electrical ceiling");
  lines.push("  id   temp  proj5m  ttt    headroom_w  band     util%  draw_w  budget_w  jobs");
  for (const r of snapshot.racks) {
    const ttt = r.time_to_throttle_s === null ? "-" : `${Math.round(r.time_to_throttle_s)}s`;
    const jobs = r.active_jobs
      .map((j) => `${j.id}(${j.priority},${j.power_w}W${j.co_located_with ? ",co_located_with=" + j.co_located_with : ""})`)
      .join("; ");
    const budget = Math.round(r.power_budget_w ?? SIM.RACK_POWER_BUDGET_W);
    lines.push(
      `  ${pad(r.id, 4)} ${pad(round(r.gpu_temp_c), 5)} ${pad(round(r.projected_temp_5m), 6)} ${pad(ttt, 6)} ${pad(Math.round(r.headroom_w), 10)}  ${pad(r.band, 8)} ${pad(Math.round(r.utilization_pct), 5)}  ${pad(Math.round(r.power_draw_w), 6)}  ${pad(budget, 8)}  ${jobs}`,
    );
  }
  const deps: string[] = [];
  for (const r of snapshot.racks)
    for (const j of r.active_jobs)
      if (j.co_located_with) {
        const partner = snapshot.racks.find((x) => x.active_jobs.some((p) => p.id === j.co_located_with));
        deps.push(`  - ${j.id} must co-locate with ${j.co_located_with}${partner ? " (currently on " + partner.id + ")" : ""}`);
      }
  if (deps.length) {
    lines.push("DEPENDENCIES:");
    lines.push(...deps);
  }
  const pending = snapshot.queue.pending.map((j) => `${j.id}(${j.priority},${j.power_w}W)`).join(", ") || "none";
  const recent = snapshot.queue.recent_placements.map((p) => `${p.job_id}->${p.rack_id}@${Math.round(p.ts)}s`).join(", ") || "none";
  lines.push(`QUEUE: pending=[${pending}]; recent=[${recent}]`);
  if (snapshot.constraints.length === 0) {
    lines.push("CONSTRAINTS: none");
  } else {
    lines.push("CONSTRAINTS (operator-added, active - you MUST satisfy all):");
    for (const c of snapshot.constraints)
      lines.push(`  - [${c.id}] ${c.kind} ${c.target}  reason="${c.reason}"  @${Math.round(c.ts)}s`);
  }
  if (snapshot.recent_advisories.length > 0) {
    lines.push("RECENT ADVISORIES (last 3, with outcome):");
    for (const rec of snapshot.recent_advisories) {
      const why = rec.operator_reason ? ` ("${rec.operator_reason}")` : "";
      lines.push(`  - ${rec.advisory.severity} ${rec.advisory.area} action="${rec.advisory.action.one_line}" -> ${rec.outcome}${why}`);
    }
  }
  return lines.join("\n");
}

function pad(v: string | number, n: number): string {
  return String(v).padEnd(n);
}

/* ------------------------------- MockProvider -------------------------------- */

/**
 * Deterministic outputs keyed to S1 stages, so the app and smoke test run offline.
 * Stage decision from the snapshot alone:
 *   - trigger "why"                       -> canned Why text
 *   - focus on A-row                      -> second-event advisory, routes around B3
 *   - focus B7 + exclude_rack B3 active   -> re-solved advisory to B15, learned_from set
 *   - focus B7, no such constraint        -> first WARN advisory, co-locates on B3
 */
export class MockProvider implements Provider {
  async classifyRisk(snapshot: Snapshot): Promise<RiskClassification[]> {
    return snapshot.racks.map((r) => {
      const margin = SIM.THROTTLE_TEMP_C - r.projected_temp_5m;
      const risk = margin <= SIM.BAND_WARN_MARGIN_C ? "at_risk" : margin <= SIM.BAND_WATCH_MARGIN_C ? "elevated" : "nominal";
      return { rack_id: r.id, risk };
    });
  }

  async advise(snapshot: Snapshot): Promise<Advisory> {
    const focusId = snapshot.focus_rack_id ?? "B7";
    const excludeB3 = snapshot.constraints.find((c) => c.kind === "exclude_rack" && c.target === "B3");
    const base = { id: `adv-${Math.round(snapshot.sim_time_s)}-${focusId}`, ts: snapshot.sim_time_s, origin: "mock" as const };

    // Second event: an A-row rack spikes; apply the learned "avoid B3" rule automatically.
    if (focusId.startsWith("A")) {
      const job = focusJob(snapshot, focusId) ?? { id: "job-4820", power_w: 700, priority: "high" as const, sla: "" };
      return {
        ...base,
        severity: "warn",
        area: `row ${focusId[0]}`,
        headline: `${focusId} projected to hit 84C throttle, routing around B3`,
        rationale: `${focusId} is projected to reach ${round(snapshot.racks.find((r) => r.id === focusId)?.projected_temp_5m ?? 84)}C within 5 minutes with negative headroom. B3 stays excluded for its firmware window, so ${focusId} offloads to B14 which has headroom.`,
        action: { type: "migrate_job", params: { job_id: job.id, from_rack: focusId, to_rack: "B14", cap_w: 11340 }, one_line: `Migrate ${job.id} from ${focusId} to B14, avoid B3` },
        alternatives: [{ type: "cap_intake", params: { from_rack: focusId }, one_line: `Cap ${focusId} intake, shed low-priority jobs` }],
        confidence: 0.8,
        learned_from: excludeB3 ? excludeB3.id : null,
      };
    }

    // B7 re-solve after the operator excluded B3: co-location is no longer achievable, so with
    // that constraint gone headroom is the right criterion and B15 (the emptiest rack) is correct.
    if (excludeB3) {
      return {
        ...base,
        severity: "warn",
        area: "B7",
        headline: "B3 excluded for firmware, co-location lost, re-solving B7 to B15",
        rationale: "B3 is excluded by your firmware constraint, so job-4471 cannot co-locate with job-4470. With co-location no longer possible, B7 offloads to B15, the rack with the most headroom (10800W), and caps its intake.",
        action: { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B15", cap_w: 11340 }, one_line: "Migrate job-4471 to B15 (co-location lost), cap B7 intake" },
        alternatives: [{ type: "cap_intake", params: { from_rack: "B7" }, one_line: "Cap B7 intake and shed low-priority batch jobs" }],
        confidence: 0.78,
        learned_from: excludeB3.id,
      };
    }

    // First WARN on B7: co-locate job-4471 with job-4470 on B3, not the emptiest rack.
    return {
      ...base,
      severity: "warn",
      area: "B7",
      headline: "B7 hits 84C throttle in ~5 min, migrate job-4471 to its partner on B3",
      rationale: "B7 draw 12600W exceeds its 11340W cooling capacity by 1260W, so it will cross its 84C throttle within about 5 minutes. job-4471 must co-locate with job-4470 on B3, which has 6200W headroom, so it goes there rather than the emptiest rack.",
      action: { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B3", cap_w: 11340 }, one_line: "Migrate job-4471 to B3 to join job-4470, cap B7 intake" },
      alternatives: [{ type: "cap_intake", params: { from_rack: "B7" }, one_line: "Cap B7 intake and shed low-priority batch jobs" }],
      confidence: 0.85,
      learned_from: null,
    };
  }

  async why(snapshot: Snapshot, _advisoryId: string): Promise<string> {
    const focusId = snapshot.focus_rack_id ?? "B7";
    const r = snapshot.racks.find((x) => x.id === focusId);
    if (!r)
      return "The focus rack is no longer in the snapshot; the situation has changed since this advisory was issued.";
    const ttt = r.time_to_throttle_s === null ? "not currently trending to throttle" : `time to throttle is ${Math.round(r.time_to_throttle_s)} seconds`;
    return `${focusId} is at ${round(r.gpu_temp_c)}C and projected to reach ${round(r.projected_temp_5m)}C within 5 minutes; ${ttt}. Its ${Math.round(r.power_draw_w)}W draw against a headroom of ${Math.round(r.headroom_w)}W is why it will cross the 84C throttle line without shedding load.`;
  }

  async interpretConstraint(text: string): Promise<InterpretedConstraint | null> {
    return heuristicConstraint(text);
  }
}

/** Deterministic fallback parse: pull a constraint out of an operator note by pattern. Used by
 *  the offline mock and as a safety net when the live model's parse does not validate. */
export function heuristicConstraint(text: string): InterpretedConstraint | null {
  const rack = text.match(/\b([AB]\d{1,2})\b/i)?.[1]?.toUpperCase();
  const job = text.match(/\b(job-\d+)\b/i)?.[1]?.toLowerCase();
  const row = text.match(/\brow\s+([AB])\b/i)?.[1]?.toUpperCase();
  const reason = text.trim();
  if (job && /\b(pin|keep|leave|hold|stay|do ?n'?t move)\b/i.test(text)) return { kind: "pin_job", target: job, reason };
  if (row && !rack) return { kind: "avoid_row", target: row, reason };
  if (rack) return { kind: "exclude_rack", target: rack, reason };
  if (job) return { kind: "pin_job", target: job, reason };
  return null;
}

function focusJob(snapshot: Snapshot, rackId: string): Job | undefined {
  const rack = snapshot.racks.find((r) => r.id === rackId);
  return rack ? highestPowerJob(rack.active_jobs) : undefined;
}

/* ------------------------------ CrusoeProvider ------------------------------- */

export class CrusoeUnavailableError extends Error {}

/**
 * Real Crusoe Managed Inference. Request shape per docs/CRUSOE_NOTES.md. The response_format
 * and thinking flags are confirmed by scripts/probe.mjs before the demo; if the probe shows
 * json_object is unreliable on Nemotron Ultra, switch `responseFormat()` to json_schema strict
 * here (one place). All schema/feasibility retry orchestration lives in the agent loop; this
 * provider does the call plus one internal zod-retry.
 */
export class CrusoeProvider implements Provider {
  private base: string;
  private modelAdvisory: string;
  private modelClassify: string;
  private key: string;

  constructor(env: InferenceEnv) {
    this.base = (env.CRUSOE_BASE_URL ?? DEFAULTS.CRUSOE_BASE_URL).replace(/\/$/, "");
    this.modelAdvisory = env.MODEL_ADVISORY ?? DEFAULTS.MODEL_ADVISORY;
    this.modelClassify = env.MODEL_CLASSIFY ?? DEFAULTS.MODEL_CLASSIFY;
    this.key = env.CRUSOE_API_KEY ?? "";
  }

  async classifyRisk(snapshot: Snapshot): Promise<RiskClassification[]> {
    const content = await this.call({
      model: this.modelClassify,
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM },
        { role: "user", content: renderSnapshot(snapshot) },
      ],
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 300,
      chat_template_kwargs: { thinking: false }, // DeepSeek flag; Nemotron uses enable_thinking
      response_format: { type: "json_object" },
    });
    try {
      const parsed = ClassifyResponseSchema.parse(JSON.parse(stripThink(content)));
      return parsed.classifications;
    } catch {
      // Fallback to code-derived classification if the model output is unusable.
      return snapshot.racks.map((r) => {
        const margin = SIM.THROTTLE_TEMP_C - r.projected_temp_5m;
        const risk = margin <= SIM.BAND_WARN_MARGIN_C ? "at_risk" : margin <= SIM.BAND_WATCH_MARGIN_C ? "elevated" : "nominal";
        return { rack_id: r.id, risk } as RiskClassification;
      });
    }
  }

  async advise(snapshot: Snapshot, feedback?: string): Promise<Advisory> {
    const user = renderSnapshot(snapshot) + (feedback ? `\n\n${feedback}` : "");
    let lastErr = "";
    const t0 = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const extra = attempt === 0 ? "" : `\n\nYour previous output was invalid: ${lastErr}. Return corrected minified JSON only.`;
      const content = await this.call({
        model: this.modelAdvisory,
        messages: [
          { role: "system", content: ADVISORY_SYSTEM },
          { role: "user", content: user + extra },
        ],
        temperature: 0.2,
        top_p: 0.95,
        max_tokens: 900,
        chat_template_kwargs: { enable_thinking: false }, // Nemotron flag
        response_format: { type: "json_object" },
      });
      const result = AdvisoryDraftSchema.safeParse(JSON.parse(safeJson(stripThink(content))));
      if (result.success) {
        return {
          ...result.data,
          id: `adv-${Math.round(snapshot.sim_time_s)}-${snapshot.focus_rack_id ?? "focus"}`,
          ts: snapshot.sim_time_s,
          origin: "model",
          latency_ms: Date.now() - t0,
        };
      }
      lastErr = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    }
    // Three schema failures: hand back the deterministic fallback (AGENT_SPEC 4c).
    return ruleBasedAdvisory(snapshot);
  }

  async why(snapshot: Snapshot, _advisoryId: string): Promise<string> {
    const content = await this.call({
      model: this.modelAdvisory,
      messages: [
        { role: "system", content: WHY_SYSTEM },
        { role: "user", content: renderSnapshot(snapshot) },
      ],
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 220,
      chat_template_kwargs: { enable_thinking: false },
    });
    return stripThink(content).trim();
  }

  async interpretConstraint(text: string, snapshot: Snapshot): Promise<InterpretedConstraint | null> {
    // Give the model the rack and job list so it can resolve a description ("the rack running the
    // checkpoint writer") to a real id. That resolution is the step a regex cannot do.
    const racks = snapshot.racks
      .map((r) => {
        const jobs = r.active_jobs.map((j) => j.id).join(", ") || "idle";
        const tag = r.id === snapshot.focus_rack_id ? ", the at-risk marginal-cooling rack" : "";
        return `  ${r.id} (row ${r.row}, ${round(r.gpu_temp_c)}C, headroom ${Math.round(r.headroom_w)}W${tag}): ${jobs}`;
      })
      .join("\n");
    const user = `Operator note: ${text}\n\nRacks and their jobs (resolve any description to one of these ids):\n${racks}`;
    try {
      const content = await this.call({
        model: this.modelAdvisory,
        messages: [
          { role: "system", content: CONSTRAINT_SYSTEM },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        top_p: 0.95,
        max_tokens: 120,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_object" },
      });
      const parsed = JSON.parse(safeJson(stripThink(content)));
      const kind = parsed?.kind;
      if (kind !== "exclude_rack" && kind !== "avoid_row" && kind !== "pin_job") return heuristicConstraint(text);
      const target = String(parsed.target ?? "").trim();
      if (!target) return heuristicConstraint(text);
      return { kind, target, reason: String(parsed.reason ?? text).trim() };
    } catch {
      return heuristicConstraint(text); // model unavailable: fall back to the pattern parse
    }
  }

  /** POST /chat/completions. */
  private async call(body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 412 = transient "no available servers". Never block the DO tick with a sleep-retry
    // (docs/CRUSOE_NOTES.md): throw immediately so doTick catches it and the next alarm tick
    // re-attempts against a now-warm model while the sim keeps advancing.
    if (res.status === 412) throw new CrusoeUnavailableError("Crusoe orchestrator: no available servers");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Crusoe ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

/** Strip a leading reasoning block defensively, even with thinking disabled. */
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Pull the first JSON object out of a string in case the model wraps it in prose. */
function safeJson(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

/* ---------------------------------- prompts ---------------------------------- */
// Kept byte-stable so Crusoe prompt caching (MemoryAlloy) stays warm across calls.

export const ADVISORY_SYSTEM = `You are Marshal, a situational-awareness agent for a live GPU data center. You watch rack thermal telemetry and propose ONE executable action a non-technical shift engineer can approve, override, or question. You never do arithmetic: every number you need is given in the snapshot. Your job is to reconcile the operator's active constraints and each rack's physical limits (the thermal cooling headroom_w and the separate electrical power budget) into a single feasible recommendation.

Rules:
- Output ONLY minified JSON matching this schema, no prose, no markdown:
  {"severity":"watch|warn|critical","area":string,"headline":string(<=90 chars),"rationale":string(2 sentences, cite >=2 numbers from the snapshot),"action":{"type":"migrate_job|cap_intake|rebalance_row|hold|no_action","params":{"job_id"?:string,"from_rack"?:string,"to_rack"?:string,"cap_w"?:number,"row"?:string},"one_line":string(<=90 chars)},"alternatives":[up to 2 action objects],"confidence":number 0..1,"learned_from":string|null}
- The action MUST satisfy every active constraint. Never target an excluded rack or an avoided row. Never move a pinned job.
- The target of a migrate MUST have headroom_w >= the job's power_w and stay within the power budget (draw_w + job power <= budget_w).
- CO-LOCATION: if the job has a co_located_with partner, migrate it to the rack HOSTING that partner, even if another rack has more headroom. Breaking co-location severely degrades the job, so never pick a rack just because it has the most headroom. If that rack is excluded by an operator constraint, pick the next-best feasible rack and say co-location could not be preserved.
- If an operator-added constraint shaped your choice, set learned_from to that constraint id (e.g. "c1"). Otherwise null.
- Thermal throttling is driven by COOLING, not the power budget: a rack heads to throttle when its draw exceeds its cooling capacity, i.e. headroom_w is negative. When you explain a thermal risk, cite the rack's cooling headroom (its draw versus its cooling capacity, e.g. "draw exceeds cooling capacity by N W"), never the power budget. The power budget is a separate electrical ceiling used only as a feasibility check on a migrate target.
- When a rack is over its cooling capacity, migrate its HIGHEST-priority job to a feasible target and cap the source rack intake to shed low-priority load. State both in one_line when both are needed.
- Terse operations English. No exclamation marks.`;

export const WHY_SYSTEM = `You are Marshal explaining a recommendation to a shift engineer. In at most 3 sentences, justify the current advisory using ONLY numbers from the snapshot (current temp, projected temp, time to throttle, headroom). Cite specific values. Do NOT propose a new action or add new advice. Terse operations English, no exclamation marks.`;

export const CONSTRAINT_SYSTEM = `You convert a shift engineer's free-text note into ONE structured operational constraint for a GPU data center scheduler. Return ONLY minified JSON: {"kind":"exclude_rack|avoid_row|pin_job","target":string,"reason":string}.
- exclude_rack: a specific rack must not receive migrations. target = the rack id, like "B3" or "B12".
- avoid_row: a whole aisle or row should be avoided. target = the row letter, like "A" or "B".
- pin_job: a specific job must not be moved off its rack. target = the job id, like "job-4471".
The note may name a rack or job by description instead of by id (for example "the rack running the checkpoint writer", "the marginal-cooling rack", "the gradient partner"). Use the rack and job list in the user message to resolve the description to the correct id. target must be an id that appears in that list.
Pick the single best-fitting kind. target is only the identifier, no extra words. reason is a short phrase. Return ONLY the JSON.`;

export const CLASSIFY_SYSTEM = `You triage GPU rack thermal risk. For each rack in the snapshot, classify risk as "nominal", "elevated", or "at_risk" based on its projected temperature and headroom. Output ONLY minified JSON: {"classifications":[{"rack_id":string,"risk":"nominal|elevated|at_risk"}]}. No prose.`;
