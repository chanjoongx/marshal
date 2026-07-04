// De-risk probe: does the REAL Nemotron reliably parse a shift engineer's free-text override note
// into a structured constraint {kind, target, reason}? Interpreting open-ended natural-language
// operator input is the load-bearing job code cannot replicate. Run: `node scripts/probe_constraint.mjs`.
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
Pick the single best-fitting kind. target is only the identifier, no extra words. reason is a short phrase capturing why. Return ONLY the JSON.`;

const CASES = [
  { note: "B3 has a firmware update in 10 minutes", kind: "exclude_rack", target: "B3" },
  { note: "B12 is down for maintenance this shift", kind: "exclude_rack", target: "B12" },
  { note: "don't put anything on row A, the CRAC unit there is being serviced", kind: "avoid_row", target: "A" },
  { note: "leave job-4471 where it is, it is mid-checkpoint", kind: "pin_job", target: "job-4471" },
];

const stripThink = (s) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
const safeJson = (s) => {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
};

async function call(note) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ADV,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: note },
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
for (const c of CASES) {
  try {
    const out = await call(c.note);
    const target = String(out.target ?? "").replace(/\s/g, "").toUpperCase();
    const ok = out.kind === c.kind && target === c.target.toUpperCase();
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"}  "${c.note}"\n      -> ${JSON.stringify(out)}  (want kind=${c.kind} target=${c.target})`);
  } catch (e) {
    console.log(`ERR   "${c.note}" -> ${e.message}`);
  }
}
console.log(`\n${pass}/${CASES.length} parsed correctly`);
process.exit(pass === CASES.length ? 0 : 1);
