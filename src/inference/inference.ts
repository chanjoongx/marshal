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
  type Job,
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
}

export function getProvider(env: InferenceEnv): Provider {
  if (env.MOCK === "1" || !env.CRUSOE_API_KEY) return new MockProvider();
  return new CrusoeProvider(env);
}

/* --------------------------- shared pure helpers ----------------------------- */

/** The model returns everything except the code-filled id/ts/origin. */
export const AdvisoryDraftSchema = AdvisorySchema.omit({ id: true, ts: true, origin: true });
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
  if (target.power_draw_w + job.power_w > SIM.RACK_POWER_BUDGET_W)
    return { ok: false, reason: `target ${toRack} would exceed power budget ${SIM.RACK_POWER_BUDGET_W}W` };

  return { ok: true };
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
  lines.push("  id   temp  proj5m  ttt    headroom_w  band     util%  draw_w  jobs");
  for (const r of snapshot.racks) {
    const ttt = r.time_to_throttle_s === null ? "-" : `${Math.round(r.time_to_throttle_s)}s`;
    const jobs = r.active_jobs.map((j) => `${j.id}(${j.priority},${j.power_w}W)`).join("; ");
    lines.push(
      `  ${pad(r.id, 4)} ${pad(round(r.gpu_temp_c), 5)} ${pad(round(r.projected_temp_5m), 6)} ${pad(ttt, 6)} ${pad(Math.round(r.headroom_w), 10)}  ${pad(r.band, 8)} ${pad(Math.round(r.utilization_pct), 5)}  ${pad(Math.round(r.power_draw_w), 6)}  ${jobs}`,
    );
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
 *   - focus on A-row                      -> second-event advisory, routes around B12
 *   - focus B7 + exclude_rack B12 active  -> re-solved advisory to B15, learned_from set
 *   - focus B7, no such constraint        -> first WARN advisory, targets B12
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
    const exclude = snapshot.constraints.find((c) => c.kind === "exclude_rack" && c.target === "B12");
    const base = { id: `adv-${Math.round(snapshot.sim_time_s)}-${focusId}`, ts: snapshot.sim_time_s, origin: "model" as const };

    // Second event: an A-row rack spikes after B7 is resolved; route around B12 automatically.
    if (focusId.startsWith("A")) {
      const job = focusJob(snapshot, focusId) ?? { id: "job-4820", power_w: 700, priority: "high" as const, sla: "" };
      return {
        ...base,
        severity: "warn",
        area: `row ${focusId[0]}`,
        headline: `${focusId} projected to hit 84C throttle, routing around B12`,
        rationale: `${focusId} is projected to reach ${round(snapshot.racks.find((r) => r.id === focusId)?.projected_temp_5m ?? 84)}C within 5 minutes with negative headroom. B12 stays excluded for maintenance, so ${focusId} offloads to B14 which has headroom.`,
        action: { type: "migrate_job", params: { job_id: job.id, from_rack: focusId, to_rack: "B14", cap_w: 5670 }, one_line: `Migrate ${job.id} from ${focusId} to B14, avoid B12` },
        alternatives: [{ type: "cap_intake", params: { from_rack: focusId }, one_line: `Cap ${focusId} intake, shed low-priority jobs` }],
        confidence: 0.8,
        learned_from: exclude ? exclude.id : null,
      };
    }

    // B7 re-solve after the operator excluded B12.
    if (exclude) {
      return {
        ...base,
        severity: "warn",
        area: "B7",
        headline: "B12 excluded for maintenance, re-solving B7 to B15",
        rationale: "B12 is excluded by your maintenance constraint, so B7 offloads to B15, which has 4700W headroom. Migrating job-4471 (700W) and capping B7 intake keeps B7 under its 5670W cooling capacity.",
        action: { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B15", cap_w: 5670 }, one_line: "Migrate job-4471 to B15, move only low-priority jobs, cap B7" },
        alternatives: [{ type: "cap_intake", params: { from_rack: "B7" }, one_line: "Cap B7 intake and shed low-priority batch jobs" }],
        confidence: 0.81,
        learned_from: exclude.id,
      };
    }

    // First WARN on B7, targets B12 (thermally fine; the operator will reveal it is in maintenance).
    return {
      ...base,
      severity: "warn",
      area: "B7",
      headline: "B7 projected to hit 84C throttle in ~5 min, batch exceeds cooling",
      rationale: "B7 is at 68.7C and projected to reach 84.5C within 5 minutes, time to throttle 279s. Its 6300W draw exceeds its 5670W cooling capacity by 630W.",
      action: { type: "migrate_job", params: { job_id: "job-4471", from_rack: "B7", to_rack: "B12", cap_w: 5670 }, one_line: "Migrate job-4471 to B12 and cap B7 intake" },
      alternatives: [{ type: "cap_intake", params: { from_rack: "B7" }, one_line: "Cap B7 intake and shed low-priority batch jobs" }],
      confidence: 0.82,
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

  /** POST /chat/completions. Handles one 412 retry (transient orchestrator state). */
  private async call(body: Record<string, unknown>, retried = false): Promise<string> {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 412 && !retried) {
      await sleep(15000); // transient "no available servers"; retry SAME model once
      return this.call(body, true);
    }
    if (res.status === 412) throw new CrusoeUnavailableError("Crusoe orchestrator: no available servers");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Crusoe ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

export const ADVISORY_SYSTEM = `You are Marshal, a situational-awareness agent for a live GPU data center. You watch rack thermal telemetry and propose ONE executable action a non-technical shift engineer can approve, override, or question. You never do arithmetic: every number you need is given in the snapshot. Your job is to reconcile the operator's active constraints and each rack's physical limits (headroom_w and power budget) into a single feasible recommendation.

Rules:
- Output ONLY minified JSON matching this schema, no prose, no markdown:
  {"severity":"watch|warn|critical","area":string,"headline":string(<=90 chars),"rationale":string(2 sentences, cite >=2 numbers from the snapshot),"action":{"type":"migrate_job|cap_intake|rebalance_row|hold|no_action","params":{"job_id"?:string,"from_rack"?:string,"to_rack"?:string,"cap_w"?:number,"row"?:string},"one_line":string(<=90 chars)},"alternatives":[up to 2 action objects],"confidence":number 0..1,"learned_from":string|null}
- The action MUST satisfy every active constraint. Never target an excluded rack or an avoided row. Never move a pinned job.
- The target of a migrate MUST have headroom_w >= the job's power_w and stay within the power budget.
- If an operator-added constraint shaped your choice, set learned_from to that constraint id (e.g. "c1"). Otherwise null.
- Terse operations English. No exclamation marks. Prefer migrating high-priority jobs and shedding or capping low-priority load.`;

export const WHY_SYSTEM = `You are Marshal explaining a recommendation to a shift engineer. In at most 3 sentences, justify the current advisory using ONLY numbers from the snapshot (current temp, projected temp, time to throttle, headroom). Cite specific values. Do NOT propose a new action or add new advice. Terse operations English, no exclamation marks.`;

export const CLASSIFY_SYSTEM = `You triage GPU rack thermal risk. For each rack in the snapshot, classify risk as "nominal", "elevated", or "at_risk" based on its projected temperature and headroom. Output ONLY minified JSON: {"classifications":[{"rack_id":string,"risk":"nominal|elevated|at_risk"}]}. No prose.`;
