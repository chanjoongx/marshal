// Headless oracle for Marshal's thermal model.
//
// Proves the constants in docs/SIM_SPEC.md produce the intended B7 curve for scenario
// S1: smooth thermal inertia (not an instant step), a natural throttle crossing roughly
// 5 minutes after the batch surge, a 5-minute projection that leads the crossing by a
// visible margin, and an approved action that bends the curve back below throttle.
//
// This is the reference implementation the sim engine (built by Cursor in src/server)
// must match. Node ESM, no dependencies. Run: `node scripts/curve_check.mjs`.

const INLET = 30; // cold-aisle / coolant inlet reference (C)
const THROTTLE = 84; // GPU junction thermal-throttle onset (C)
const TAU = 220; // thermal time constant (s) under test
const HORIZON = 300; // 5-minute projection horizon (s)
const DREF = THROTTLE - INLET; // reference delta-T that defines cooling_capacity_w (54)

// --- thermal model (mirror these exactly in the sim engine) ---
const steadyState = (P, capacity) => INLET + (DREF * P) / capacity;
const stepTemp = (T, Tss, dt) => Tss + (T - Tss) * Math.exp(-dt / TAU);
const project = (T, Tss) => Tss + (T - Tss) * Math.exp(-HORIZON / TAU);
const timeToThrottle = (T, Tss) => {
  if (T >= THROTTLE) return 0;
  if (Tss <= THROTTLE) return null; // not heading past throttle
  return TAU * Math.log((Tss - T) / (Tss - THROTTLE));
};
const headroom = (P, capacity) => capacity - P; // extra heat power before steady-state hits throttle
const band = (t) => {
  const m = THROTTLE - t;
  if (m <= 0) return "critical";
  if (m <= 5) return "warn";
  if (m <= 15) return "watch";
  return "nominal";
};

// --- B7: the marginal-cooling hero rack ---
const B7_CAP = 11340; // heat removal at delta-T 54 == 210 W/C conductance
const P0 = 6720; // nominal draw -> steady-state 62 C
const SURGE = 5880; // job-4471 (high, 1400 W) + 4 batch jobs (1120 W each = 4480)
const P1 = P0 + SURGE; // 12600 -> steady-state 90 C

const SURGE_T = 120; // batch lands at t+2m
const ACTION_T = 210; // operator approves ~90 s after surge
const ACTION_REMOVE = 4760; // migrate 4471 (1400) + cap sheds 3 low-pri batch (3360)

function run(withAction) {
  let T = steadyState(P0, B7_CAP);
  const rows = [];
  let crossed = null;
  let peakRate = 0;
  let prevT = T;
  for (let t = 0; t <= 600; t++) {
    let P = t < SURGE_T ? P0 : P1;
    if (withAction && t >= ACTION_T) P = P1 - ACTION_REMOVE;
    const Tss = steadyState(P, B7_CAP);
    const proj = project(T, Tss);
    const ttt = timeToThrottle(T, Tss);
    if (crossed === null && T >= THROTTLE) crossed = t;
    if (t > 0) peakRate = Math.max(peakRate, Math.abs(T - prevT));
    if (t % 20 === 0) {
      rows.push({
        t,
        T: +T.toFixed(1),
        Tss: +Tss.toFixed(1),
        proj: +proj.toFixed(1),
        ttt: ttt === null ? "-" : Math.round(ttt),
        hr: Math.round(headroom(P, B7_CAP)),
        band: band(T),
        pband: band(proj),
      });
    }
    prevT = T;
    T = stepTemp(T, Tss, 1);
  }
  return { rows, crossed, peakRate, finalT: T };
}

function table(title, rows) {
  console.log(`\n${title}`);
  console.log("  t    T    Tss  proj  ttt   hr    band     pband");
  for (const r of rows) {
    console.log(
      `  ${String(r.t).padStart(3)}  ${String(r.T).padStart(4)}  ${String(r.Tss).padStart(4)}  ${String(r.proj).padStart(4)}  ${String(r.ttt).padStart(4)}  ${String(r.hr).padStart(5)}  ${r.band.padEnd(8)} ${r.pband}`,
    );
  }
}

const noAction = run(false);
const action = run(true);

table("S1 without action (B7):", noAction.rows);
table("S1 with action at t=210 (B7):", action.rows);

// migration target B15: healthy cooling, low load, receives job-4471 (700 W)
const B15_CAP = 16200; // 300 W/C
const B15_P0 = 5400; // B15 baseline draw, steady-state ~48 C
const B15_after = B15_P0 + 1400;
const B15_Tss_after = steadyState(B15_after, B15_CAP);
console.log(
  `\nB15 target after receiving job-4471: draw ${B15_after} W, steady-state ${B15_Tss_after.toFixed(1)} C, headroom ${headroom(B15_after, B15_CAP)} W, band ${band(B15_Tss_after)}`,
);

// projection-leads-crossing check at the surge tick
const atSurge = noAction.rows.find((r) => r.t === 120);

const checks = [];
const ok = (name, cond) => {
  checks.push({ name, pass: !!cond });
};

ok(`natural crossing 280-360 s after surge (got ${noAction.crossed - SURGE_T} s)`, noAction.crossed !== null && noAction.crossed - SURGE_T >= 280 && noAction.crossed - SURGE_T <= 360);
ok(`at surge, current band nominal but projected band warn+ (proj ${atSurge.proj}, pband ${atSurge.pband})`, atSurge.band === "nominal" && (atSurge.pband === "warn" || atSurge.pband === "critical"));
ok(`projection leads crossing by >= 240 s (lead ${noAction.crossed - 120} s from surge, warn fires at surge)`, noAction.crossed - 120 >= 240);
ok(`smooth: peak dT per sim-second <= 0.2 C (got ${noAction.peakRate.toFixed(3)})`, noAction.peakRate <= 0.2);
ok(`with action, B7 never throttles (crossed=${action.crossed})`, action.crossed === null);
ok(`with action, B7 returns to nominal (final ${action.finalT.toFixed(1)} C)`, band(action.finalT) === "nominal");
ok(`target B15 stays safe after migration (band ${band(B15_Tss_after)})`, band(B15_Tss_after) === "nominal");

console.log("\n--- checks ---");
let allPass = true;
for (const c of checks) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.pass) allPass = false;
}
console.log(`\n${allPass ? "ALL PASS" : "FAILURES PRESENT"}  (TAU=${TAU}, B7_CAP=${B7_CAP}, P0=${P0}, P1=${P1})`);
process.exit(allPass ? 0 : 1);
