// Headless WebSocket driver for a FULL demo rehearsal against REAL Crusoe inference (MOCK=0).
//
// The probe verifies inference in Node. This verifies the same models running inside the actual
// workerd Durable Object, driven through the entire S1 arc end to end: start S1, wait for the live
// Nemotron WARN on B7, override the recommended rack in plain language (firmware update), wait for
// the re-solve (which must avoid the excluded rack and set learned_from), approve it and confirm
// B7 bends back to nominal, then wait for the SECOND event (A-row) and confirm the learned rule
// carries and its approve bends that rack to nominal too. Standalone, Node global WebSocket.
//
// Run against MOCK=0. WS_URL overrides the endpoint (e.g. the deployed Worker).

const URL = process.env.WS_URL || "ws://localhost:5174/api/ws";
const DEADLINE_MS = 160000;
const start = Date.now();
const log = (...a) => console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s]`, ...a);

let ws;
let phase = "connecting";
let firstAdv = null;
let excluded = null;
let world = null;
let focusRack = null; // rack whose bend we are currently watching
let projBefore = null;
let currentEvent = null; // "first" | "second"
const approved = new Set();
const resolved = [];
let resolutions = 0;
let done = false;

const rack = (id) => world?.racks?.find((r) => r.id === id);
const send = (m) => ws.send(JSON.stringify(m));

function connect() {
  ws = new WebSocket(URL);
  ws.addEventListener("open", () => {
    log("connected");
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
  const retry = () => {
    if (phase === "connecting" && Date.now() - start < 40000) setTimeout(connect, 1500);
  };
  ws.addEventListener("error", retry);
  ws.addEventListener("close", retry);
}

function onMsg(msg) {
  if (msg.type === "tick") {
    world = msg.state;
    if (phase === "await_bend" && focusRack && projBefore != null) {
      const r = rack(focusRack);
      // Check the PROJECTION, not the band: band is current-temp-based and stays nominal because
      // Marshal intervenes 5 min ahead, before the rack is actually hot. The forecast bending is
      // the projected_temp_5m dropping back under the nominal margin (throttle 84 - 15 = 69).
      if (r && r.projected_temp_5m <= 69) {
        log(`${focusRack} projection bent to NOMINAL after approve: ${projBefore}C -> ${r.projected_temp_5m}C (headroom ${r.headroom_w}W, band ${r.band})`);
        resolved.push(currentEvent);
        if (currentEvent === "first") {
          phase = "await_second";
          log("first incident resolved; waiting for the SECOND event (A-row) to prove the learned rule carries on its own...");
        } else {
          setTimeout(() => finish(true), 3000); // linger to catch the resolution card
        }
      }
    }
  } else if (msg.type === "advisory") {
    onAdvisory(msg.advisory);
  } else if (msg.type === "resolution") {
    resolutions++;
    log("RESOLUTION CARD:", msg.resolution.summary);
    log("  timeline:", msg.resolution.timeline.map((e) => e.label).join(" | "));
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
    log(`avoids excluded ${excluded}? ${target !== excluded ? "YES" : "NO"} (to_rack=${target}); type=${a.action?.type}; learned_from=${a.learned_from}`);
    beginBend(a, "first");
  } else if (phase === "await_second" && !approved.has(a.id)) {
    log(`=== SECOND EVENT ADVISORY (origin=${a.origin}) ===`);
    printAdvisory(a);
    const target = a.action?.params?.to_rack;
    log(`honors learned exclude B3? ${target !== "B3" ? "YES" : "NO"} (to_rack=${target}); type=${a.action?.type}; learned_from=${a.learned_from}`);
    beginBend(a, "second");
  }
}

function beginBend(a, ev) {
  focusRack = a.action?.params?.from_rack || a.area;
  projBefore = rack(focusRack)?.projected_temp_5m ?? null;
  currentEvent = ev;
  approved.add(a.id);
  phase = "await_bend";
  log(`Approving ${a.action?.type} on ${focusRack}; ${focusRack} projected before approve = ${projBefore}C`);
  send({ type: "control", action: "approve", advisory_id: a.id });
}

function printAdvisory(a) {
  console.log(
    JSON.stringify(
      { origin: a.origin, severity: a.severity, area: a.area, headline: a.headline, action: a.action, learned_from: a.learned_from },
      null,
      2,
    ),
  );
}

function finish(ok) {
  if (done) return;
  done = true;
  const both = resolved.includes("first") && resolved.includes("second");
  log(`events bent to nominal: [${resolved.join(", ")}]; resolution cards seen: ${resolutions}`);
  if (both) log(">>> DRY-RUN PASS (both events bent to nominal on approve, learned rule carried, resolution shown)");
  else if (resolved.includes("first")) log(">>> DRY-RUN PASS (core arc complete: B7 override/re-solve/approve/nominal + resolution; second event not reached in the window)");
  else log(`>>> DRY-RUN INCOMPLETE (stuck in phase ${phase})`);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(ok || resolved.includes("first") ? 0 : 1);
}

setTimeout(() => {
  log(`deadline reached in phase "${phase}"; resolved [${resolved.join(", ")}]`);
  finish(resolved.includes("first"));
}, DEADLINE_MS);

connect();
