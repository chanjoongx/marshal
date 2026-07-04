# DEMO_SCRIPT.md

The 60-second demo is the spec. One take, 1920x1080, product footage only, no slides, no
voiceover. All on-screen text is the app's own UI. Captions below are what the UI renders from
live state and real Nemotron output; the prompt constrains the format, so wording is close, and
the learned chip, timeline, and control flow are deterministic code.

The demo runs REAL Crusoe inference (MOCK=0, key in .dev.vars), not the mock. Warm both models
first (run `npm run probe` or issue one warmup call) so no cold 412 hits mid-take.

## Which rack is "in maintenance"

The override loop works with whichever rack Marshal recommends; the operator overrides that rack
as in maintenance and Marshal re-solves to another. In probe testing the live Nemotron model
recommends B15 first (the rack furthest down the row from the hot B7), so the captions below use
B15 -> B12. Offline (MOCK=1) the deterministic mock recommends B12 -> B15, which is what the
smoke test asserts. During the take, override whatever rack Marshal actually shows.

## Speed and timing

Record scenario S1 at 4x. Recording starts at sim t~=88s (a few seconds before the surge). Each
video second is 4 sim-seconds. Without action B7 does not cross 84C until sim t~=460 (video
~93s), well past the clip, and we intervene by sim ~230 (video ~35s), so there is comfortable
margin and B7 never actually throttles on screen.

| video | sim t | what is on screen |
|---|---|---|
| 0-8s | 88-120 | console + nominal |
| 8-20s | 120-168 | surge + WARN card |
| 20-30s | 168-208 | Why + Override |
| 30-45s | 208-268 | re-solve + Approve + curve bends |
| 45-55s | 268-308 | second event, routes around the maintenance rack |
| 55-60s | 308-328 | resolution |

## Arc

### 0-8s  Dark NOC-style ops console
Agent feed is the hero on the primary column; the rack heatmap sits to the side as a subtle
thermal grid, B7 green at ~62C. Status line and tag chip visible:
- status: `Marshal watching 24 racks, cluster nominal, B-row utilization climbing`
- tag chip: `predicts rack thermal throttling before it happens`

### 8-20s  Batch surge, WARN before throttle
A scheduler burst lands jobs on B-row. B7 begins rising (62 -> ~67C) but its band is still
nominal. Before any throttle, a WARN card appears in the feed:
- headline: `B7 projected to hit 84C throttle in ~5 min, batch load exceeds cooling`
- buttons: `Approve`  `Override`  `Why`
- action line on the card: `Migrate job-4471 to B15 and cap B7 intake`

### 20-30s  Why, then Override with a real constraint
Engineer taps `Why`. Marshal answers in 3 sentences citing live numbers, no new advice:
- why: `B7 is at ~67C and projected to reach ~84C within 5 minutes; time to throttle ~279s.
  Its 6300W draw exceeds its 5670W cooling capacity by 630W, so without shedding load it will
  cross the 84C throttle line.`
Engineer taps `Override` and adds a constraint the telemetry cannot know:
- override reason: `B15 is in maintenance, do not target it`  (kind exclude_rack, target = the
  rack Marshal recommended)

### 30-45s  Reconcile, re-solve, Approve, curve bends
Marshal injects the constraint and re-solves in seconds. A new advisory replaces the old:
- headline: `B15 excluded for maintenance, re-solving B7 to B12`
- action line: `Migrate job-4471 to B12, move only low-priority jobs, cap B7`
- learned chip on the card: `learned: avoids maintenance racks`
Engineer taps `Approve`. The target rack lights up in the heatmap. B7's projected-temp line
visibly bends down and away from the 84C throttle line (projection falls toward ~67C).

### 45-55s  Second event, learning proven
A different aisle spikes: A-row (A4-A6) takes a surge. The new advisory carries the same
`learned: avoids maintenance racks` chip and routes around the excluded rack on its own, without
being told again:
- headline: `A5 projected to hit 84C throttle, routing around the maintenance rack`
- action line: `Migrate job-4820 from A5 to B14`
Engineer taps `Approve`.

### 55-60s  Resolution
Temps return to nominal. A resolution card shows a mini incident timeline: surge -> warn -> why
-> override -> re-solve -> approve -> second event -> resolved. Always visible at the bottom: the
`SIMULATED TELEMETRY` badge and the footer
`reasoning: NVIDIA-Nemotron-3-Ultra-550B via Crusoe Managed Inference`.

## Pre-flight checklist

- MOCK=0, `CRUSOE_API_KEY` in `.dev.vars`, both models warmed (`npm run probe` green).
- Footer shows the Nemotron-via-Crusoe line; `SIMULATED TELEMETRY` badge visible.
- Speed set to 4x; window at 1920x1080; hide bookmarks and notifications.
- Dry-run the click path once and note which rack Marshal recommends, so you override the right
  one (Why -> Override that rack -> Approve -> second event -> Approve).
- Record one clean take. Upload to YouTube unlisted or Loom. Put the URL in SUBMISSION.md.
