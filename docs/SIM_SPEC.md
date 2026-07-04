# SIM_SPEC.md

The deterministic, seeded simulation that feeds Marshal. This is the physical world the
agent watches: a GPU data center pod, its rack telemetry, its scheduler queue. Everything
here is CODE. The LLM does zero arithmetic; it only reasons over the numbers this spec
produces. `scripts/curve_check.mjs` is the executable oracle for the thermal model, and the
sim engine (built by Cursor in `src/server`) must match it. Constants live in
`src/shared/types.ts` under `SIM`; import them, do not retype.

Honesty boundary: the rack telemetry and cluster are SIMULATED. The app must always show a
`SIMULATED TELEMETRY` badge. What is real: the agent loop, the Crusoe Nemotron inference, the
constraint reconciliation, the override learning, and the action-feasibility validation.

## 1. GPU and data-center specs (researched, cited)

Anchored on a real accelerator so the numbers survive a Crusoe engineer's scrutiny.

- GPU: NVIDIA H100 SXM5. TDP 700 W per GPU. Junction temperature target under sustained
  100% load is <= 85 C; thermal throttling engages in the low-to-mid 80s C. We set the
  throttle onset at 84 C. Sources: NVIDIA H100 datasheet
  (https://resources.nvidia.com/en-us-gpu-resources/h100-datasheet-24306), H100 700 W
  cooling analysis (https://www.szwecent.com/what-h100-gpu-cooling-solutions-manage-700w-tdp-challenges/).
- Rack: 8 GPUs per HGX/DGX H100 node. An 8-GPU node dissipates ~10-12 kW; dense GPU racks
  run 10-50 kW. Air cooling is inadequate above ~35 kW, where direct-to-chip liquid cooling
  is required. Next-gen GB200 NVL72 racks reach 120-140 kW with integrated liquid cooling.
  Sources: Introl 50 kW rack guide
  (https://introl.com/blog/liquid-cooling-gpu-data-centers-50kw-thermal-limits-guide),
  Tom's Hardware data-center cooling 2025
  (https://www.tomshardware.com/pc-components/cooling/the-data-center-cooling-state-of-play-2025-liquid-cooling-is-on-the-rise-thermal-density-demands-skyrocket-in-ai-data-centers-and-tsmc-leads-with-direct-to-silicon-solutions),
  Data Center Frontier on rising rack densities
  (https://www.datacenterfrontier.com/cooling/article/55281394/coolit-and-accelsius-push-data-center-liquid-cooling-limits-amid-soaring-rack-densities).

## 2. Thermal model (first-order lumped capacitance)

A rack's GPU thermal state (`gpu_temp_c`) is modeled as a first-order lumped-capacitance system
(Newton's law of cooling): temperature moves toward a load-dependent steady state with a single
time constant (~220 s here), so it has visible multi-minute inertia and rises and falls smoothly
rather than instantly. This is deliberately a multi-minute abstraction. The ~220 s constant is the
heatsink and coolant thermal mass that dominates the minutes-scale response, which is the only
timescale a 5-minute forecast cares about; the model does not resolve the fast sub-second silicon
die transient, which is irrelevant at a 5-minute horizon. That slow-mass inertia is exactly what
makes a 5-minute prediction physically legitimate rather than a straight-line extrapolation
gimmick. The throttle onset is 84 C, the temperature at which the H100 begins thermal throttling.

Definitions (all in `src/shared/types.ts` `SIM`):

- `INLET_TEMP_C = 30` cold-aisle / coolant inlet reference.
- `THROTTLE_TEMP_C = 84` GPU throttle onset (the H100 throttles in the low-to-mid 80s C, section 1).
- `THERMAL_TAU_S = 220` time constant, tuned (section 6).
- `PROJECTION_HORIZON_S = 300` the 5-minute lookahead.
- `DREF = THROTTLE_TEMP_C - INLET_TEMP_C = 54` the reference delta-T that defines a rack's
  `cooling_capacity_w`: a rack's `cooling_capacity_w` is the heat power it removes at a 54 C
  rise above inlet. Cooling conductance `G = cooling_capacity_w / DREF` (W/C).

Formulas the sim engine must implement exactly (mirrored in `curve_check.mjs`):

```
steady_state(P, cap)   = INLET + DREF * P / cap        // temp the rack settles to at heat power P
step_temp(T, Tss, dt)  = Tss + (T - Tss) * exp(-dt / TAU)   // exact update over dt sim-seconds
projected_temp_5m(T,Tss) = Tss + (T - Tss) * exp(-PROJECTION_HORIZON_S / TAU)
time_to_throttle(T,Tss):
    if T >= THROTTLE: 0
    elif Tss <= THROTTLE: null            // not heading past throttle
    else: TAU * ln((Tss - T) / (Tss - THROTTLE))
headroom_w(P, cap)     = cap - P          // extra heat power before steady state hits throttle
```

Here `P` is the rack's heat power in watts, which equals `power_draw_w`, the TOTAL rack
electrical power (GPUs plus host, network, and cooling overhead), essentially all of which
becomes heat, not GPU-only power. A rack's `cooling_capacity_w` (11-16 kW here) is its
heat-removal capacity, and both scales are consistent with the 10-12 kW per 8-GPU node and
10-50 kW dense-rack figures cited in section 1. Use the EXACT
exponential `step_temp`, not Euler; it is stable for any step size, so advancing 8 sim-seconds
in one tick at 8x is still correct.

Integration: the sim advances in 1-sim-second sub-steps. At speed S, each real tick runs S
sub-steps (S in {1, 4, 8}). This keeps job and scheduler events aligned to whole sim-seconds
and keeps 1x, 4x, 8x numerically identical apart from wall-clock.

## 3. Thermal bands and the advisory trigger

Two distinct uses of the same band function `band(temp)` on margin `m = THROTTLE - temp`:

| margin m (C) | band |
|---|---|
| m > 15 | nominal |
| 5 < m <= 15 | watch |
| 0 < m <= 5 | warn |
| m <= 0 | critical |

- Rack status (the heatmap color, `RackState.band`) uses `band(current_temp)`.
- The advisory trigger uses `band(projected_temp_5m)`. When a rack's PROJECTED band crosses
  into warn or worse (from nominal or watch), the agent is triggered (see AGENT_SPEC). This
  is the predictive part: the rack can still look nominal now while its projection is already
  warn, which is precisely the "warn before it throttles" moment.

## 4. Topology (24 racks)

One pod, two aisles, 24 racks total:

- Aisle B (main GPU compute aisle): `B1`..`B15` (15 racks).
- Aisle A (mixed aisle): `A1`..`A9` (9 racks).

The aisles are intentionally different lengths so the demo's fixed rack IDs (B7, B3, B15)
stay valid without renumbering. Real data-center rows vary in length, so this is credible.

Each rack: `gpus = 8`, `power_budget_w = 24000`, `inlet_temp_c = 30`. Cooling capacity by
class:

- Healthy racks: `cooling_capacity_w = 16200` (G = 300 W/C), ~16 kW of heat removal at the throttle delta-T.
- B7 is the marginal-cooling hero rack (mid-aisle, restricted airflow):
  `cooling_capacity_w = 11340` (G = 210 W/C), ~11 kW. This is why B7, not its neighbors, crosses under
  a shared batch surge.

Nominal load: each rack carries jobs summing to a `power_draw_w` that puts it in the low 60s C.
B7 nominal draw is `6720 W` -> steady state 62 C. Three B-row racks run light with real headroom
to receive work: B12 draw `6000 W` (headroom `10200 W`), B14 draw `5700 W` (headroom `10500 W`),
and B15 draw `5400 W` (headroom `10800 W`, the most headroom in the pod, steady state 48 C).

B3 is the co-location host, and it is the reason the migration target is not just a headroom
lookup. It runs three jobs: `job-4470` (high priority, 1800 W, the gradient partner), `ckpt-9`
(low, 1600 W), and `b3-svc` (normal, 6600 W), a `10000 W` draw and `6200 W` headroom. That
headroom is deliberately below B15's `10800 W`, so a headroom-only rule would never pick B3. When
the surge job `job-4471` lands co-located with `job-4470` (section 6), the correct target is B3,
not the emptiest rack, and reconciling that dependency is the model's real job. In probe testing
the live Nemotron model picks B3 for the co-location (3/3 runs, `scripts/probe_reasoning.mjs`)
and adapts to another rack once B3 is excluded; the deterministic MockProvider does the same,
co-locating on B3 then re-solving to B15 after the override. Either way the override-and-learn
loop is identical.

## 5. Determinism

- No wall-clock, no unseeded randomness in sim logic. Drive everything from an integer
  `sim_time_s` counter and a seeded PRNG (mulberry32, seed `0x4D41` = "MA") used only for
  cosmetic inlet jitter of at most +/-0.2 C. Core dynamics (loads, job placements, scenario
  events) are scripted, not random.
- Job IDs are deterministic and scenario-scripted (e.g. `job-4471`).
- Same scenario + same speed => identical `sim_time_s` -> state mapping every run. This is
  what lets the MockProvider key canned outputs to sim stages and lets the smoke test assert
  exact behavior.

## 6. Scenario S1: "Batch surge on B-row" (the demo scenario)

Timeline in sim-time (canonical; the demo recording maps video-time onto this, see
DEMO_SCRIPT):

- `t = 0..120s` nominal. Cluster note: "cluster nominal, B-row utilization climbing." B7 at
  62 C. All racks nominal.
- `t = 120s` the scheduler places a heavy batch on B-row. On B7 this lands `job-4471` (high
  priority, 1400 W, a distributed-training job with a co-location dependency: it must run on the
  same rack as its gradient partner `job-4470`, which is on B3) plus 4 low-priority batch jobs at
  1120 W each (4480 W). B7 heat power goes 6720 -> 12600 W. Its `headroom_w` goes +4620 -> -1260 W:
  draw now exceeds its 11340 W cooling capacity by 1260 W, so it will heat toward a steady state of
  90 C.
- Without action, B7 crosses 84 C at `t ~= 460s` (about 5.6 min after the surge). At the surge
  tick, `projected_temp_5m = 82.8 C` (warn) while `current_temp = 62 C` (nominal) and
  `time_to_throttle = 339 s`. The agent fires a WARN advisory here, roughly 5.6 minutes before
  the actual crossing.

Action effects the sim MUST model, so approvals visibly bend the curve:

- `migrate_job(job_id, from, to)`: removes that job's `power_w` from the source rack's heat
  power (curve bends down there) and adds it to the target rack. The target must have
  `headroom_w >= job.power_w` and stay within `power_budget_w`, or the action is infeasible
  (the agent's feasibility check rejects it before surfacing; see AGENT_SPEC).
- `cap_intake(rack, cap_w)`: caps further heat input on the rack and sheds its lowest-priority
  jobs one at a time until the rack's projected margin returns above the nominal threshold
  (15 C). It never sheds high-priority jobs; those are migrated, not dropped.
- The demo's approved action on B7 is `migrate_job(job-4471 -> B15)` plus `cap_intake(B7)`.
  Migrating 4471 removes 1400 W; the cap sheds 3 of the 4 low-priority batch jobs (3360 W).
  B7 heat power 12600 -> 7840 W, steady state -> 67 C, and the curve bends from ~71 C back down
  to 68 C nominal. It never throttles.
- The first advisory migrates `job-4471` to B3 to preserve its co-location with `job-4470`, not
  to the emptiest rack. Because B3's `6200 W` headroom is below B15's `10800 W`, a headroom-only
  rule would grab B15 and break the gradient exchange; the advisory surfaces that contrast on
  screen (code computes it with `naiveHeadroomPick`, only when the co-location was actually
  achievable). The operator then overrides with something telemetry cannot see: B3 has a firmware
  update in 10 minutes (an `exclude_rack B3` constraint). Co-location is now impossible, so the
  agent re-solves to B15; with the dependency gone, headroom is the right criterion, and a
  healthy rack receiving `job-4471` settles around 54 C, well within nominal. The learned
  constraint persists for every later advisory (the UI shows a "learned: avoids B3" chip).

Second pressure event (drives the second advisory that shows learning):

- `t = 300s` (after B7 is resolved) a different aisle spikes: `A5` takes a surge whose
  high-priority job `job-4820` ALSO co-locates with `job-4470` on B3. But B3 is excluded now, so
  the agent avoids B3 on its own and picks another feasible rack (the mock uses B14), carrying
  the same `learned_from` chip without being told again. This is the learning proof: an operator
  rule added mid-incident reshapes the next decision. Because the co-location partner is on an
  excluded rack, no rule-vs-model contrast is shown here (the model had no better co-location to
  reach for), which keeps that contrast honest.

### Validated B7 curve (from `scripts/curve_check.mjs`, TAU=220)

```
S1 without action (B7):
  t    T    Tss  proj  ttt   hr    band     pband
  100  62    62    62     -   4620  nominal  nominal
  120  62    90  82.8   339  -1260  nominal  warn      <- surge; warn fires here
  160  66.7  90   84    299  -1260  nominal  critical
  200  70.5  90   85    259  -1260  watch    critical
  340  79.7  90  87.4   119  -1260  warn     critical
  460  84    90  88.5     0  -1260  critical critical  <- natural crossing (~5.6 min after surge)

S1 with action at t=210 (B7):
  120  62    90  82.8   339  -1260  nominal  warn
  200  70.5  90   85    259  -1260  watch    critical
  220  71.2  67.3 68.3    -   3500  watch    nominal   <- action applied; curve bends down
  420  68.9  67.3 67.7    -   3500  nominal  nominal   <- returned to nominal, never throttled
```

`node scripts/curve_check.mjs` prints `ALL PASS` for: smooth inertia (peak 0.127 C/sim-s),
natural crossing 280-360 s after surge (339 s), projection leads the crossing by >= 240 s,
action prevents throttle, action returns B7 to nominal, and the B15 target stays safe after
migration. If any constant changes, re-run it and update the numbers above.

## 7. Scenario S2: "Cooling unit degradation" (stretch, cut-ladder item 2)

A row's cooling degrades: drop `cooling_capacity_w` by ~30% on all racks in a row over ~60 s
(a failing CDU). Steady-state temps drift up across the row with no load change. The agent
should detect the row-wide projected drift and advise rebalancing jobs off the degraded row
onto healthy racks with headroom, respecting the same feasibility checks. Same override and
learning mechanics apply. Build S1 fully first; S2 only if ahead of schedule.

## 8. What the sim publishes

Every tick the engine computes `RackState[]` (raw telemetry + code-derived
`projected_temp_5m`, `time_to_throttle_s`, `headroom_w`, `band`), the `ClusterSummary`, the
`SchedulerQueue`, active `Constraint[]` and `ActiveEffect[]`, and recent `AdvisoryRecord[]`,
and sends a `WorldState` (see `protocol.ts` `tick`). None of these derived numbers are ever
computed by the LLM.
