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

A rack's GPU junction temperature is modeled as a first-order thermal system. This is the
standard lumped-capacitance model (Newton's law of cooling): temperature moves toward a
load-dependent steady state with a time constant, so it has visible inertia and rises and
falls smoothly rather than instantly. That inertia is exactly what makes a 5-minute
prediction physically legitimate rather than a straight-line extrapolation gimmick.

Definitions (all in `src/shared/types.ts` `SIM`):

- `INLET_TEMP_C = 30` cold-aisle / coolant inlet reference.
- `THROTTLE_TEMP_C = 84` junction throttle onset.
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

Here `P` is the rack's heat power in watts, which equals its IT electrical draw
(`power_draw_w`) since essentially all electrical power becomes heat. Use the EXACT
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

The aisles are intentionally different lengths so the demo's fixed rack IDs (B7, B12, B15)
stay valid without renumbering. Real data-center rows vary in length, so this is credible.

Each rack: `gpus = 8`, `power_budget_w = 12000`, `inlet_temp_c = 30`. Cooling capacity by
class:

- Healthy racks: `cooling_capacity_w = 8100` (G = 150 W/C).
- B7 is the marginal-cooling hero rack (mid-aisle, restricted airflow):
  `cooling_capacity_w = 5670` (G = 105 W/C). This is why B7, not its neighbors, crosses under
  a shared batch surge.

Nominal load: each rack carries jobs summing to a `power_draw_w` that puts it in the low 60s C.
B7 nominal draw is `3360 W` -> steady state 62 C. Both B12 and B15 run light with real headroom
to receive work: B12 draw `3000 W` (headroom `5100 W`, steady state 50 C), B14 draw `2850 W`
(headroom `5250 W`), B15 draw `2700 W` (headroom `5400 W`, steady state 48 C). B15 has the most
headroom and is furthest down the row from the hot B7, so in probe testing the live Nemotron
model favors it; the deterministic MockProvider recommends B12 first and re-solves to B15. Either
way the override-and-learn loop is identical.

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
  priority, 700 W, a full-GPU inference job) plus 4 low-priority batch jobs at 560 W each
  (2240 W). B7 heat power goes 3360 -> 6300 W. Its `headroom_w` goes +2310 -> -630 W: draw now
  exceeds its 5670 W cooling capacity by 630 W, so it will heat toward a steady state of 90 C.
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
- The demo's approved action on B7 is `migrate_job(job-4471 -> target)` plus `cap_intake(B7)`.
  Migrating 4471 removes 700 W; the cap sheds 3 of the 4 low-priority batch jobs (1680 W).
  B7 heat power 6300 -> 3920 W, steady state -> 67 C, and the curve bends from ~71 C back down
  to 68 C nominal. It never throttles.
- The agent recommends a headroom-rich target (the live model favors B15, the mock uses B12).
  The operator overrides the recommended rack as in maintenance (an `exclude_rack` constraint),
  and the agent re-solves to the other feasible target, which still has headroom (a healthy rack
  receiving job-4471 settles around 54 C, well within nominal). The learned constraint persists
  for every later advisory.

Second pressure event (drives the second advisory that shows learning):

- `t ~= 300s` (after B7 is resolved) a different aisle spikes: A-row racks `A4..A6` take a
  surge. The best thermal target for the migration would again be a B-row rack; the agent must
  route around `B12` on its own because the `exclude_rack B12` constraint is now active, and
  the advisory carries `learned_from` set to that constraint (UI renders a "learned: avoids
  maintenance racks" chip). It picks `B14` or `B15`, never B12, without being told again.

### Validated B7 curve (from `scripts/curve_check.mjs`, TAU=220)

```
S1 without action (B7):
  t    T    Tss  proj  ttt   hr    band     pband
  100  62    62    62     -   2310  nominal  nominal
  120  62    90  82.8   339   -630  nominal  warn      <- surge; warn fires here
  160  66.7  90   84    299   -630  nominal  critical
  200  70.5  90   85    259   -630  watch    critical
  340  79.7  90  87.4   119   -630  warn     critical
  460  84    90  88.5     0   -630  critical critical  <- natural crossing (~5.6 min after surge)

S1 with action at t=210 (B7):
  120  62    90  82.8   339   -630  nominal  warn
  200  70.5  90   85    259   -630  watch    critical
  220  71.2  67.3 68.3    -   1750  watch    nominal   <- action applied; curve bends down
  420  68.9  67.3 67.7    -   1750  nominal  nominal   <- returned to nominal, never throttled
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
