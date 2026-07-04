# DEMO_SCRIPT.md

The 60-second demo is the spec. One take, 1920x1080, product footage only, no slides, no
voiceover. All on-screen text is the app's own UI. Captions below are what the UI renders from
live state and real Nemotron output; the prompt constrains the format, so wording is close, and
the learned chip, timeline, and control flow are deterministic code.

The demo runs REAL Crusoe inference (MOCK=0, key in .dev.vars), not the mock. Warm both models
first (run `npm run probe` or issue one warmup call) so no cold 412 hits mid-take.

## Which rack, and why B3

Unlike a plain headroom pick, the first target is deterministic. `job-4471` must co-locate with
its gradient partner `job-4470` on B3, so both the live Nemotron model (B3 in 3/3 probe runs,
`node scripts/probe_reasoning.mjs`) and the offline mock recommend B3, even though B3's 6200 W
headroom is well below B15's 10800 W. The operator overrides B3 as having a firmware update in 10
minutes (an `exclude_rack B3` constraint the telemetry cannot know). Marshal re-solves: with the
co-location no longer reachable, headroom becomes the right criterion, so it routes `job-4471` to
B15, the emptiest rack. The second event then routes around B3 on its own (the mock uses B14; the
live model picks whichever feasible rack it prefers). During the take, override B3 with the
firmware reason, which is exactly what the smoke test drives.

## Speed and timing

Record scenario S1 at 4x. Recording starts at sim t~=88s (a few seconds before the surge). Each
video second is 4 sim-seconds. Without action B7 does not cross 84C until sim t~=460 (video
~93s), well past the clip, and we intervene by sim ~230 (video ~35s), so there is comfortable
margin and B7 never actually throttles on screen.

| video | sim t | what is on screen |
|---|---|---|
| 0-8s | 88-120 | console + nominal |
| 8-20s | 120-168 | surge + WARN card (co-locates on B3) + forecast chart + rule-vs-model box |
| 20-30s | 168-208 | Why + Override B3 (firmware) |
| 30-45s | 208-268 | re-solve to B15 + Approve + forecast bends away from 84C |
| 45-55s | 268-308 | second event, routes around B3 on its own |
| 55-60s | 308-328 | resolution |

## Arc

### 0-8s  Dark NOC-style ops console
Agent feed is the hero on the primary column; the rack heatmap sits to the side as a subtle
thermal grid, B7 green at ~62C. Status line and tag chip visible:
- status: `Marshal watching 24 racks, cluster nominal, B-row utilization climbing`
- tag chip: `predicts rack thermal throttling before it happens`

### 8-20s  Batch surge, WARN before throttle
A scheduler burst lands jobs on B-row. B7 begins rising (62 -> ~67C) but its band is still
nominal. Before any throttle, a WARN card appears in the feed, and the MARSHAL FORECAST chart
opens beside it: B7's measured line climbing, its 5-minute projection reaching for the 84C
throttle line drawn across the top.
- headline: `B7 hits 84C throttle in ~5 min, migrate job-4471 to its partner on B3`
- action line on the card: `Migrate job-4471 to B3 to join job-4470, cap B7 intake`
- rule-vs-model box on the card: `a headroom-only rule would  Migrate job-4471 to B15 (most
  headroom, 10800W) — breaks job-4471's co-location with job-4470 on B3`
- buttons: `Approve`  `Override`  `Why`
That box is the whole thesis on screen: the greedy rule grabs the emptiest rack and breaks the
gradient exchange; Marshal keeps the two jobs together on B3.

### 20-30s  Why, then Override with a real constraint
Engineer taps `Why`. Marshal answers in 3 sentences citing live numbers, no new advice:
- why: `B7 is at 68.7C and projected to reach 84.5C within 5 minutes; time to throttle is 279
  seconds. Its 12600W draw against a headroom of -1260W is why it will cross the 84C throttle line
  without shedding load.`
Engineer taps `Override` and adds a constraint the telemetry cannot know:
- override target: `B3`, reason: `firmware update in 10 min`  (kind exclude_rack)

### 30-45s  Reconcile, re-solve, Approve, forecast bends away
Marshal injects the constraint and re-solves in seconds. With B3 excluded the co-location can no
longer be preserved, so headroom becomes the right criterion and a new advisory replaces the old:
- headline: `B3 excluded for firmware, co-location lost, re-solving B7 to B15`
- action line: `Migrate job-4471 to B15 (co-location lost), cap B7 intake`
- learned chip on the card: `learned: avoids B3 (firmware update in 10 min)`
Engineer taps `Approve`. B15 lights up in the heatmap, and in the MARSHAL FORECAST the projection
line bends down and away from the 84C throttle line before the chart clears as B7 settles back to
nominal.

### 45-55s  Second event, learning proven
A different aisle spikes: A5 takes a surge whose high-priority job also co-locates with job-4470
on B3. But B3 is excluded now, so the new advisory carries the same `learned: avoids B3` chip and
routes around B3 on its own, without being told again. There is no rule-vs-model box this time,
because with the partner's rack excluded the model has no better co-location to reach for:
- headline: `A5 projected to hit 84C throttle, routing around B3`
- action line: `Migrate job-4820 from A5 to B14, avoid B3`
The forecast chart reappears for A5. Engineer taps `Approve`.

### 55-60s  Resolution
Temps return to nominal. A resolution card shows a mini incident timeline: surge -> warn -> why
-> override -> re-solve -> approve -> second event -> resolved. Always visible at the bottom: the
`SIMULATED TELEMETRY` badge and the footer
`reasoning: NVIDIA-Nemotron-3-Ultra-550B via Crusoe Managed Inference`.

## Pre-flight checklist

- MOCK=0, `CRUSOE_API_KEY` in `.dev.vars`, both models warmed (`npm run probe` green). Optionally
  run `node scripts/probe_reasoning.mjs` once to confirm the live model still picks B3 for the
  co-location.
- Footer shows the Nemotron-via-Crusoe line; `SIMULATED TELEMETRY` badge visible.
- Speed set to 4x; window at 1920x1080; hide bookmarks and notifications.
- On the first advisory, confirm the MARSHAL FORECAST chart and the rule-vs-model box both render
  before you touch anything; they are the two visible beats the pitch points at.
- Dry-run the click path once. The first target is B3 (co-location), so the path is fixed:
  Why -> Override B3 with "firmware update in 10 min" -> Approve the B15 re-solve -> second event
  -> Approve.
- Record one clean take. Upload to YouTube unlisted or Loom. Put the URL in SUBMISSION.md.
