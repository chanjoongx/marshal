// De-risk probe: does the REAL Nemotron parse a shift engineer's free-text override note into a
// structured constraint {kind, target, reason}, INCLUDING notes that name the rack or job only by
// description (no id)? A regex fallback can pull an id out of "B3 has a firmware update", but it
// cannot resolve "the rack running the checkpoint writer" to B3. That resolution, from the rack
// list in context, is the load-bearing step only the model can do. Run: `node scripts/probe_constraint.mjs`.
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

const SYSTEM = `You convert a shift engineer's free-text note into ONE structured operational constraint for a GPU data center scheduler. Return ONLY minified JSON: {"kind":"exclude_rack|avoid_row|pin_job","target":string,"reason":string}.
- exclude_rack: a specific rack must not receive migrations. target = the rack id, like "B3" or "B12".
- avoid_row: a whole aisle or row should be avoided. target = the row letter, like "A" or "B".
- pin_job: a specific job must not be moved off its rack. target = the job id, like "job-4471".
The note may name a rack or job by description instead of by id (for example "the rack running the checkpoint writer", "the marginal-cooling rack", "the gradient partner"). Use the rack and job list in the user message to resolve the description to the correct id. target must be an id that appears in that list.
Pick the single best-fitting kind. target is only the identifier, no extra words. reason is a short phrase. Return ONLY the JSON.`;

// Illustrative snapshot the operator is looking at (mirrors scenario S1).
const RACKS = `  B7 (row B, 69C, headroom -1260W, the at-risk marginal-cooling rack): job-4471, batch-1, batch-2
  B3 (row B, 63C, headroom 6200W): job-4470, ckpt-9, b3-svc
  B15 (row B, 48C, headroom 10800W): job-b15
  A5 (row A, 58C, headroom 5800W): job-a5`;

const CASES = [
  { note: "B3 has a firmware update in 10 minutes", kind: "exclude_rack", target: "B3" },
  { note: "don't put anything on row A, the CRAC unit there is being serviced", kind: "avoid_row", target: "A" },
  { note: "leave job-4471 where it is, it is mid-checkpoint", kind: "pin_job", target: "job-4471" },
  // Description-only (no id in the note): only a model reading the rack list can resolve these.
  { note: "the rack running the checkpoint writer is getting a firmware update", kind: "exclude_rack", target: "B3", descriptive: true },
  { note: "take the marginal-cooling rack out of rotation", kind: "exclude_rack", target: "B7", descriptive: true },
];

const stripThink = (s) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
const safeJson = (s) => {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
};

async function call(note) {
  const user = `Operator note: ${note}\n\nRacks and their jobs (resolve any description to one of these ids):\n${RACKS}`;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ADV,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 120,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return JSON.parse(safeJson(stripThink(j.choices?.[0]?.message?.content ?? "")));
}

let pass = 0;
let descPass = 0;
let descTotal = 0;
for (const c of CASES) {
  if (c.descriptive) descTotal++;
  try {
    const out = await call(c.note);
    const target = String(out.target ?? "").replace(/\s/g, "").toUpperCase();
    const ok = out.kind === c.kind && target === c.target.toUpperCase();
    if (ok) {
      pass++;
      if (c.descriptive) descPass++;
    }
    console.log(
      `${ok ? "PASS" : "FAIL"}${c.descriptive ? " [description-only, no id, a regex cannot do this]" : ""}  "${c.note}"\n      -> ${JSON.stringify(out)}  (want kind=${c.kind} target=${c.target})`,
    );
  } catch (e) {
    console.log(`ERR   "${c.note}" -> ${e.message}`);
  }
}
console.log(`\n${pass}/${CASES.length} parsed correctly; ${descPass}/${descTotal} of them description-only (which a regex fallback cannot resolve, so the model is load-bearing there)`);
process.exit(pass === CASES.length ? 0 : 1);
