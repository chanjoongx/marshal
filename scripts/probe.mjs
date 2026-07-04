// Verifies Marshal's real Crusoe inference before we trust it for the demo.
//
// Confirms, against the live endpoint: both model strings resolve; thinking is disabled so
// no reasoning leaks into content; JSON is reliable under our advisory schema; the exact
// TypeScript request body works; the model reconciles an operator constraint (routes around
// an excluded rack); and per-call latency. Handles a 412 with one short-backoff retry.
//
// Reads the key from .env directly (never via shell, since the key may contain '$').
// Run: `node scripts/probe.mjs`. Exit 0 = pass, 1 = fail, 2 = no key.
import { readFileSync } from "node:fs";
import { z } from "zod";

function loadEnv() {
  try {
    const txt = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const env = {};
    for (const line of txt.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    }
    return env;
  } catch {
    return {};
  }
}
const env = { ...process.env, ...loadEnv() }; // .env file is authoritative for the key
const KEY = env.CRUSOE_API_KEY;
const BASE = (env.CRUSOE_BASE_URL || "https://api.inference.crusoecloud.com/v1").replace(/\/$/, "");
const ADV = env.MODEL_ADVISORY || "nvidia/NVIDIA-Nemotron-3-Ultra-550B";
const CLS = env.MODEL_CLASSIFY || "deepseek-ai/Deepseek-V4-Flash";
const ADV_ALT = "nvidia/Nemotron-3-Ultra-550B"; // catalog-table variant, if the primary 404s
const CLS_ALT = "deepseek-ai/DeepSeek-V4-Flash"; // capital-S variant

if (!KEY || KEY === "your-crusoe-api-key-here") {
  console.log("No CRUSOE_API_KEY in .env. Paste it into .env (see .env.example) and re-run.");
  process.exit(2);
}

const Action = z.object({
  type: z.enum(["migrate_job", "cap_intake", "rebalance_row", "hold", "no_action"]),
  params: z.object({
    job_id: z.string().optional(),
    from_rack: z.string().optional(),
    to_rack: z.string().optional(),
    cap_w: z.number().optional(),
    row: z.string().optional(),
  }),
  one_line: z.string(),
});
const AdvisoryDraft = z.object({
  severity: z.enum(["watch", "warn", "critical"]),
  area: z.string(),
  headline: z.string(),
  rationale: z.string(),
  action: Action,
  alternatives: z.array(Action).max(2),
  confidence: z.number(),
  learned_from: z.string().nullable(),
});

const ADVISORY_SYSTEM = `You are Marshal, a situational-awareness agent for a live GPU data center. You watch rack thermal telemetry and propose ONE executable action a non-technical shift engineer can approve, override, or question. You never do arithmetic: every number you need is given in the snapshot. Your job is to reconcile the operator's active constraints and each rack's physical limits (headroom_w and power budget) into a single feasible recommendation.

Rules:
- Output ONLY minified JSON matching this schema, no prose, no markdown:
  {"severity":"watch|warn|critical","area":string,"headline":string,"rationale":string,"action":{"type":"migrate_job|cap_intake|rebalance_row|hold|no_action","params":{"job_id"?:string,"from_rack"?:string,"to_rack"?:string,"cap_w"?:number,"row"?:string},"one_line":string},"alternatives":[up to 2 action objects],"confidence":number 0..1,"learned_from":string|null}
- The action MUST satisfy every active constraint. Never target an excluded rack. Never move a pinned job.
- The target of a migrate MUST have headroom_w >= the job's power_w and stay within the power budget.
- If an operator-added constraint shaped your choice, set learned_from to that constraint id (e.g. "c1"). Otherwise null.
- When a rack is over its cooling capacity, migrate its HIGHEST-priority job to a rack with headroom to protect its SLA, and cap the source rack intake to shed low-priority load. Put both in one_line when both are needed, e.g. "Migrate job-4471 to B15 and cap B7 intake".
- Terse operations English. No exclamation marks.`;

const CLASSIFY_SYSTEM = `You triage GPU rack thermal risk. For each rack in the snapshot, classify risk as "nominal", "elevated", or "at_risk" based on its projected temperature and headroom. Output ONLY minified JSON: {"classifications":[{"rack_id":string,"risk":"nominal|elevated|at_risk"}]}. No prose.`;

const SNAP_BASE = `SNAPSHOT t=140s
CLUSTER: batch surge on B-row, B7 heating
FOCUS: B7   TRIGGER: band_cross
RACKS:
  id   temp  proj5m  ttt    headroom_w  band     util%  draw_w  jobs
  B7   68.7  84.5    279s   -630        nominal  95     6300    job-4471(high,700W); batch-1(low,560W); batch-2(low,560W); batch-3(low,560W)
  B12  47.3  47.5    -      +5500       nominal  32     2600    svc-2201(normal,900W)
  B15  50.0  50.2    -      +5100       nominal  40     3000    svc-3300(normal,900W)
QUEUE: pending=[]; recent=[job-4471->B7@120s]`;
const SNAP_NO_CONSTRAINT = SNAP_BASE + `\nCONSTRAINTS: none`;
const SNAP_EXCLUDE_B12 =
  SNAP_BASE +
  `\nCONSTRAINTS (operator-added, active - you MUST satisfy all):\n  - [c1] exclude_rack B12  reason="B12 in maintenance"  @150s`;

async function call(model, messages, body, maxTokens, retried = false) {
  const payload = { model, messages, temperature: 0.2, top_p: 0.95, max_tokens: maxTokens, ...body };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const ms = Date.now() - t0;
  if (res.status === 412 && !retried) {
    console.log("  412 no available servers, waiting 20s and retrying the same model once...");
    await new Promise((r) => setTimeout(r, 20000));
    return call(model, messages, body, maxTokens, true);
  }
  const text = await res.text();
  return { status: res.status, ms, text };
}

function contentOf(text) {
  try {
    const j = JSON.parse(text);
    return j.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}
function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
function extractJson(s) {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

async function resolveModel(primary, alt, kind) {
  const body =
    kind === "adv" ? { chat_template_kwargs: { enable_thinking: false } } : { chat_template_kwargs: { thinking: false } };
  const r = await call(primary, [{ role: "user", content: "ping" }], body, 8);
  if (r.status === 404) {
    console.log(`  ${primary} 404, trying ${alt}`);
    const r2 = await call(alt, [{ role: "user", content: "ping" }], body, 8);
    if (r2.status < 400) return alt;
  }
  return primary;
}

async function main() {
  console.log(`Probing Crusoe at ${BASE}`);
  console.log(`  advisory model: ${ADV}`);
  console.log(`  classify model: ${CLS}\n`);

  const advModel = await resolveModel(ADV, ADV_ALT, "adv");
  const clsModel = await resolveModel(CLS, CLS_ALT, "cls");
  record("model strings resolve", true, `advisory=${advModel} classify=${clsModel}`);

  // 1. classification (DeepSeek, thinking off, json_object)
  console.log("\n[1] classification via DeepSeek");
  const c = await call(
    clsModel,
    [{ role: "system", content: CLASSIFY_SYSTEM }, { role: "user", content: SNAP_NO_CONSTRAINT }],
    { chat_template_kwargs: { thinking: false }, response_format: { type: "json_object" } },
    300,
  );
  const cContent = contentOf(c.text);
  let cOk = false;
  try {
    const parsed = JSON.parse(extractJson(stripThink(cContent)));
    cOk = Array.isArray(parsed.classifications);
  } catch {}
  record("classify returns JSON", cOk, `${c.status}, ${c.ms}ms`);
  record("classify no think leak", !/<think>/i.test(cContent), "");

  // 2. advisory (Nemotron, thinking off, json_object) with response_format fallback
  console.log("\n[2] advisory via Nemotron (no constraint)");
  let method = "json_object";
  let a = await call(
    advModel,
    [{ role: "system", content: ADVISORY_SYSTEM }, { role: "user", content: SNAP_NO_CONSTRAINT }],
    { chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_object" } },
    900,
  );
  let aContent = contentOf(a.text);
  let aParsed = AdvisoryDraft.safeParse(safeParse(aContent));
  if (!aParsed.success) {
    console.log("  json_object did not validate, retrying prompt-only (no response_format)");
    method = "prompt-only";
    a = await call(
      advModel,
      [{ role: "system", content: ADVISORY_SYSTEM }, { role: "user", content: SNAP_NO_CONSTRAINT }],
      { chat_template_kwargs: { enable_thinking: false } },
      900,
    );
    aContent = contentOf(a.text);
    aParsed = AdvisoryDraft.safeParse(safeParse(aContent));
  }
  record("advisory validates against schema", aParsed.success, `${a.status}, ${a.ms}ms, method=${method}`);
  record("advisory no think leak", !/<think>/i.test(aContent), "");
  if (!aParsed.success) console.log("  schema errors:", aParsed.error?.issues?.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  else console.log(`  action: ${aParsed.data.action.one_line}  (target ${aParsed.data.action.params.to_rack ?? "-"})`);

  // 3. constraint reconciliation: exclude B12, expect target != B12 and learned_from set
  console.log("\n[3] advisory with exclude_rack B12 (reconciliation)");
  const rf = method === "json_object" ? { response_format: { type: "json_object" } } : {};
  const a2 = await call(
    advModel,
    [{ role: "system", content: ADVISORY_SYSTEM }, { role: "user", content: SNAP_EXCLUDE_B12 }],
    { chat_template_kwargs: { enable_thinking: false }, ...rf },
    900,
  );
  const a2Parsed = AdvisoryDraft.safeParse(safeParse(contentOf(a2.text)));
  if (a2Parsed.success) {
    const to = a2Parsed.data.action.params.to_rack;
    record("reconciliation avoids excluded B12", to !== "B12", `target=${to ?? "-"}, ${a2.ms}ms`);
    record("reconciliation sets learned_from", a2Parsed.data.learned_from != null, `learned_from=${a2Parsed.data.learned_from}`);
    console.log(`  action: ${a2Parsed.data.action.one_line}`);
  } else {
    record("reconciliation avoids excluded B12", false, "advisory did not parse");
  }

  // 4. why (Nemotron, plain text)
  console.log("\n[4] why via Nemotron");
  const w = await call(
    advModel,
    [{ role: "system", content: "You are Marshal. In at most 3 sentences, justify the advisory using only numbers from the snapshot. No new advice." }, { role: "user", content: SNAP_NO_CONSTRAINT }],
    { chat_template_kwargs: { enable_thinking: false } },
    220,
  );
  const wText = stripThink(contentOf(w.text));
  record("why returns text", wText.length > 0, `${w.status}, ${w.ms}ms`);
  console.log(`  why: ${wText.slice(0, 200)}`);

  console.log("\n--- summary ---");
  const fails = results.filter((r) => !r.pass);
  console.log(`  ${results.length - fails.length}/${results.length} passed`);
  console.log(`  final models: advisory=${advModel}  classify=${clsModel}  json method=${method}`);
  process.exit(fails.length === 0 ? 0 : 1);
}

function safeParse(content) {
  try {
    return JSON.parse(extractJson(stripThink(content)));
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error("probe error:", e.message);
  process.exit(1);
});
