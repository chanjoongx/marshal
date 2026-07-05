// Headless WebSocket driver for a demo rehearsal against REAL Crusoe inference (MOCK=0).
//
// The probe verifies inference in Node. This verifies the same models running inside the actual
// workerd Durable Object, driven through the full agent loop: it starts S1, waits for the live
// Nemotron WARN on B7, overrides the recommended rack in plain language (firmware update), waits for the
// re-solve (which must avoid the excluded rack and set learned_from), approves it, and confirms
// B7's projected temperature bends down. Standalone, uses Node's global WebSocket. Not the app.
//
// Run against a dev server started with MOCK=0. WS_URL overrides the endpoint.

const URL = process.env.WS_URL || "ws://localhost:5174/api/ws";
const DEADLINE_MS = 110000;
const start = Date.now();
const log = (...a) => console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s]`, ...a);

let ws;
let phase = "connecting";
let firstAdv = null;
let excluded = null;
let projBefore = null;
let latestB7 = null;
let done = false;
let reachedNominal = false;
let loggedBend = false;
let sawResolution = false;

const b7 = (world) => world?.racks?.find((r) => r.id === "B7");
const send = (m) => ws.send(JSON.stringify(m));

function connect() {
  ws = new WebSocket(URL);
  ws.addEventListener("open", () => {
    log("connected to dev server");
    phase = "await_first";
    send({ type: "control", action: "start_scenario", scenario: "S1" });
    send({ type: "control", action: "set_speed", speed: 8 });
    log("started S1 at 8x; waiting for the first live advisory (real Nemotron, expect a few s latency)...");
  });
  ws.addEventListener("message", (ev) => {
    try {
      onMsg(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  ws.addEventListener("error", () => {
    if (phase === "connecting" && Date.now() - start < 40000) setTimeout(connect, 1500);
  });
  ws.addEventListener("close", () => {
    if (phase === "connecting" && Date.now() - start < 40000) setTimeout(connect, 1500);
  });
}

function onMsg(msg) {
  if (msg.type === "tick") {
    const r = b7(msg.state);
    if (r) latestB7 = r;
    if (phase === "await_bend" && projBefore != null && r) {
      if (r.projected_temp_5m <= 69 && !reachedNominal) {
        reachedNominal = true;
        log(`B7 returned to NOMINAL after approve: projected ${projBefore}C -> ${r.projected_temp_5m}C (headroom ${r.headroom_w}W, band ${r.band})`);
        setTimeout(() => finish(true), 3000); // linger to catch the resolution card
      } else if (!reachedNominal && !loggedBend && r.projected_temp_5m < projBefore - 2) {
        loggedBend = true;
        log(`B7 projected bending down: ${projBefore}C -> ${r.projected_temp_5m}C, still settling (want <= 69C nominal)...`);
      }
    }
  } else if (msg.type === "advisory") {
    onAdvisory(msg.advisory);
  } else if (msg.type === "resolution") {
    sawResolution = true;
    log("RESOLUTION CARD:", msg.resolution.summary);
    log("  timeline:", msg.resolution.timeline.map((e) => e.label).join(" | "));
  } else if (msg.type === "agent_status" && phase === "await_first") {
    // quiet
  }
}

function onAdvisory(a) {
  if (phase === "await_first") {
    firstAdv = a;
    excluded = a.action?.params?.to_rack || "B15";
    log(`=== FIRST ADVISORY (origin=${a.origin}) ===`);
    printAdvisory(a);
    phase = "await_resolve";
    const note = `${excluded} has a firmware update in 10 min`;
    log(`Operator override (plain language): "${note}" - model must interpret this into exclude_rack ${excluded}`);
    send({ type: "control", action: "override", advisory_id: a.id, text: note });
  } else if (phase === "await_resolve" && a.id !== firstAdv.id) {
    log(`=== RE-SOLVE ADVISORY (origin=${a.origin}) ===`);
    printAdvisory(a);
    const target = a.action?.params?.to_rack;
    log(`avoids excluded ${excluded}? ${target !== excluded ? "YES" : "NO"} (target=${target}); learned_from=${a.learned_from}; cap_w=${a.action?.params?.cap_w ?? "MISSING"}`);
    projBefore = latestB7?.projected_temp_5m ?? null;
    phase = "await_bend";
    log(`Approving; B7 projected before approve = ${projBefore}C`);
    send({ type: "control", action: "approve", advisory_id: a.id });
  }
}

function printAdvisory(a) {
  console.log(
    JSON.stringify(
      {
        origin: a.origin,
        severity: a.severity,
        area: a.area,
        headline: a.headline,
        rationale: a.rationale,
        action: a.action,
        learned_from: a.learned_from,
        confidence: a.confidence,
      },
      null,
      2,
    ),
  );
}

function finish(ok) {
  if (done) return;
  done = true;
  log(ok ? `>>> DRY-RUN PASS (B7 nominal; resolution card ${sawResolution ? "SHOWN" : "not seen"})` : ">>> DRY-RUN INCOMPLETE");
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(ok ? 0 : 1);
}

setTimeout(() => {
  log(`deadline reached in phase "${phase}"; B7 projected now ${latestB7?.projected_temp_5m}C, reachedNominal=${reachedNominal}`);
  finish(reachedNominal);
}, DEADLINE_MS);

connect();
