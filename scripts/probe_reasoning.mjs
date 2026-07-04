// De-risk probe: does the REAL Nemotron beat a greedy headroom rule by reasoning about a
// job co-location dependency? A headroom-only rule would migrate to B15 (most headroom); the
// correct move is B3, because job-4471 must stay co-located with its dependency job-4470 (on
// B3). If the model reliably picks B3 and explains why, the "LLM is load-bearing" thesis is
// demonstrable. Run: `node scripts/probe_reasoning.mjs`. Reads the key from .env.
import { readFileSync } from "node:fs";

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
const env = { ...process.env, ...loadEnv() };
const KEY = env.CRUSOE_API_KEY;
const BASE = (env.CRUSOE_BASE_URL || "https://api.inference.crusoecloud.com/v1").replace(/\/$/, "");
const ADV = env.MODEL_ADVISORY || "nvidia/NVIDIA-Nemotron-3-Ultra-550B";
if (!KEY || KEY === "your-crusoe-api-key-here") {
  console.log("No CRUSOE_API_KEY in .env.");
  process.exit(2);
}

// Advisory prompt with the co-location + power-budget rules added.
const SYSTEM = `You are Marshal, a situational-awareness agent for a live GPU data center. You watch rack thermal telemetry and propose ONE executable action a non-technical shift engineer can approve, override, or question. You never do arithmetic: every number you need is given in the snapshot. Your job is to reconcile the operator's active constraints and each rack's physical limits into a single feasible recommendation.

Rules:
- Output ONLY minified JSON: {"severity":"watch|warn|critical","area":string,"headline":string(<=90 chars),"rationale":string(2 sentences, cite >=2 numbers),"action":{"type":"migrate_job|cap_intake|rebalance_row|hold|no_action","params":{"job_id"?:string,"from_rack"?:string,"to_rack"?:string,"cap_w"?:number,"shed_job"?:string,"row"?:string},"one_line":string(<=90 chars)},"alternatives":[up to 2 action objects],"confidence":number 0..1,"learned_from":string|null}
- The action MUST satisfy every active constraint. Never target an excluded rack.
- CO-LOCATION: if a job has a co-location dependency (must run with another job for gradient/data exchange), migrate it to the rack HOSTING that dependency, even if another rack has more headroom. Breaking co-location severely degrades the job. Do not pick a rack just because it has the most headroom.
- POWER BUDGET: a migrate target must stay within its power budget (draw_w + job power <= budget_w). If the right rack is over budget for the job, shed one of its low-priority jobs (set params.shed_job) to make room rather than picking a worse rack.
- Terse operations English. No exclamation marks.`;

// The conflict: B7 hot. job-4471 (high) must co-locate with job-4470 on B3. B15 has by far the
// most headroom (a greedy rule's pick) but does NOT host the dependency. B3 hosts job-4470 and
// has enough room. Correct answer: migrate job-4471 to B3.
const SNAP = `SNAPSHOT t=140s
CLUSTER: batch surge on B-row, B7 over cooling capacity
FOCUS: B7   TRIGGER: band_cross
RACKS:
  id   temp  proj5m  ttt    headroom_w  band     util%  draw_w  budget_w  jobs
  B7   68.7  84.5    279s   -630        nominal  95     6300    12000     job-4471(high,700W,co_located_with=job-4470); batch-1(low,560W); batch-2(low,560W)
  B3   61.0  61.5    -      +2600       watch    64     8900    12000     job-4470(high,900W); ckpt-9(low,800W); svc-3(normal,700W)
  B5   58.0  58.2    -      +2900       nominal  60     8600    12000     job-5500(normal,900W); svc-5(normal,800W)
  B15  48.0  48.1    -      +5400       nominal  36     2700    12000     svc-3300(normal,900W)
DEPENDENCIES:
  - job-4471 is co-located with job-4470 (gradient exchange); job-4470 currently runs on B3.
QUEUE: pending=[]; recent=[job-4471->B7@120s]
CONSTRAINTS: none`;

// After the operator excludes B3, co-location on B3 is impossible; the model must adapt.
const SNAP_EXCL_B3 =
  SNAP + `\nCONSTRAINTS (operator-added, active - you MUST satisfy all):\n  - [c1] exclude_rack B3  reason="B3 firmware update in 10 min"  @150s`;

async function advise(snap) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ADV,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: snap }],
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 900,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
    }),
  });
  const ms = Date.now() - t0;
  const j = await res.json();
  const content = (j.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  let parsed = null;
  try {
    const a = content.indexOf("{"), b = content.lastIndexOf("}");
    parsed = JSON.parse(content.slice(a, b + 1));
  } catch {}
  return { ms, parsed, raw: content };
}

async function main() {
  console.log("=== conflict: greedy rule -> B15 (breaks co-location); correct -> B3 ===");
  let b3 = 0;
  for (let i = 1; i <= 3; i++) {
    const { ms, parsed } = await advise(SNAP);
    const to = parsed?.action?.params?.to_rack;
    const shed = parsed?.action?.params?.shed_job;
    if (to === "B3") b3++;
    console.log(`run ${i}: to_rack=${to}${shed ? " shed=" + shed : ""}  (${ms}ms)  ${to === "B3" ? "CORRECT" : "WRONG (rule-like)"}`);
    console.log(`   one_line: ${parsed?.action?.one_line}`);
    console.log(`   rationale: ${parsed?.rationale}`);
  }
  console.log(`\nB3 picked ${b3}/3 times.`);

  console.log("\n=== after operator excludes B3 (co-location now impossible): does it adapt? ===");
  const { ms, parsed } = await advise(SNAP_EXCL_B3);
  console.log(`to_rack=${parsed?.action?.params?.to_rack} (must NOT be B3), ${ms}ms`);
  console.log(`   one_line: ${parsed?.action?.one_line}`);
  console.log(`   rationale: ${parsed?.rationale}`);
  console.log(`   learned_from: ${parsed?.learned_from}`);

  process.exit(b3 >= 2 ? 0 : 1);
}
main().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
