# AGENT_SPEC.md

How Marshal turns the simulated world into proactive, trustworthy advisories. This is the
contract for the agent loop, the two-tier inference, the snapshot format, the validation
loops, and the exact prompts. Types are in `src/shared/types.ts`; the inference interface is
in `src/inference/inference.ts`; Crusoe request mechanics are in `docs/CRUSOE_NOTES.md`.

Core claim this spec makes true: the LLM does the part rules cannot. It reconciles conflicting
operational constraints (a target rack's thermal headroom, a job's priority and SLA, a job's
co-location dependency, a maintenance window an operator added, the power budget) into one
executable migration a non-technical engineer can run. Code computes every number; the LLM never
does arithmetic. The demo makes this concrete: the model migrates a job to the moderately loaded
rack that hosts its gradient partner, which a headroom-only rule would skip, and the UI shows the
two picks side by side.

## 1. Two-tier trigger policy

Three layers, only the top one is expensive:

- Tier 1, CODE (every tick, zero cost): compute `RackState` for all 24 racks, including
  `projected_temp_5m`, `time_to_throttle_s`, `headroom_w`, and `band`. Determine the at-risk
  set: racks whose PROJECTED band is `watch` or worse. If the set is empty, emit an
  `agent_status` line and stop. No model calls.
- Tier 2, DeepSeek-V4-Flash (only when the at-risk set is non-empty, cheap): classify each
  at-risk rack as `nominal | elevated | at_risk` from a compact snapshot. This is the cost
  gate and triage: only `at_risk` racks escalate. Most ticks never reach Tier 3.
- Tier 3, Nemotron-Ultra-550B (rare, high-stakes): generate the full structured Advisory for
  the single most urgent `at_risk` rack that is not debounced. One advisory at a time.

This mirrors the workshop's documented three-tier escalation pattern (CRUSOE.md section 6),
extended with the constraint reconciliation and feasibility validation below.

Debounce: do not issue a new advisory for a rack within `SIM.DEBOUNCE_S` (20) sim-seconds of
its last advisory, UNLESS its severity escalates (warn -> critical) or an operator override
just occurred for it. Override always forces an immediate re-solve.

The heavy tier is also consulted, outside the tick trigger, on: an operator override
(re-solve with the new constraint), a Why request, and optionally a one-line resolution
summary.

## 2. Snapshot to the heavy model

Compact structured text, target under ~1400 tokens. Keep the system prompt byte-stable and put
this volatile snapshot in the user message so the system prefix stays cache-hot (CRUSOE_NOTES,
prompt caching). Include only the at-risk racks plus the focus rack plus up to ~4 candidate
target racks (healthy racks with the most headroom), not all 24, to stay compact. On top of
that, ALWAYS include the rack hosting a co-location partner of any focus job, even when its
headroom would otherwise keep it out of the candidate list. That is the whole point: the correct
co-location target is a moderately loaded rack a headroom ranking would cut, so the model has to
be able to see it to choose it (`buildSnapshot` in `src/server/agent.ts`).

Format (exact, deterministic ordering):

```
SNAPSHOT t=<sim_time_s>s
CLUSTER: <cluster_note>
FOCUS: <focus_rack_id>   TRIGGER: <band_cross|override|why|resolution>
RACKS:
  id   temp  proj5m  ttt    headroom_w  band     util%  draw_w  budget_w  jobs
  B7   68.7  84.5    279s   -630        nominal  100    6300    12000     job-4471(high,700W,co_located_with=job-4470); batch-1(low,560W); batch-2(low,560W)
  B3   63.3  63.3    -      3100        nominal  89     5000    12000     job-4470(high,900W); ckpt-9(low,800W); b3-svc(normal,3300W)
  B15  48.0  48.0    -      5400        nominal  48     2700    12000     job-b15(normal,2700W)
DEPENDENCIES:
  - job-4471 must co-locate with job-4470 (currently on B3)
QUEUE: pending=[job-5540(low,560W)]; recent=[job-4471->B7@120s]
CONSTRAINTS: none
```

Two things the format now carries. Each job prints its `co_located_with` partner inline when it
has one, and a `budget_w` column gives the model the per-rack power ceiling it must stay under.
A `DEPENDENCIES` block then names each co-located job and where its partner currently runs, so
the co-location target is explicit rather than something the model has to infer from the job
list. B3 above is in the snapshot only because it hosts `job-4470`: on headroom alone (3100 W,
below B15's 5400 W) it would be cut, and then the model could not pick it. If there are no
constraints, print `CONSTRAINTS: none`; the constraint and dependency blocks are the point, since
they turn advice generation into constraint reconciliation. When an operator constraint is
active it prints as a `CONSTRAINTS (operator-added, active - you MUST satisfy all):` block with
one `[id] kind target reason=... @ts` line each, and the last three advisories print under
`RECENT ADVISORIES (last 3, with outcome):` with their approve/override/dismiss outcome.

## 3. The advisory call (Tier 3)

Model `nvidia/NVIDIA-Nemotron-3-Ultra-550B`, thinking disabled
(`chat_template_kwargs: { enable_thinking: false }`), `temperature: 0.2`, `top_p: 0.95`,
`max_tokens: 900`, `response_format: { type: "json_object" }` (see CRUSOE_NOTES for the
verify-in-probe caveat).

System prompt (byte-stable, do not vary between calls; the source of truth is
`ADVISORY_SYSTEM` in `src/inference/inference.ts`, reproduced here verbatim):

```
You are Marshal, a situational-awareness agent for a live GPU data center. You watch rack thermal telemetry and propose ONE executable action a non-technical shift engineer can approve, override, or question. You never do arithmetic: every number you need is given in the snapshot. Your job is to reconcile the operator's active constraints and each rack's physical limits (headroom_w and power budget) into a single feasible recommendation.

Rules:
- Output ONLY minified JSON matching this schema, no prose, no markdown:
  {"severity":"watch|warn|critical","area":string,"headline":string(<=90 chars),"rationale":string(2 sentences, cite >=2 numbers from the snapshot),"action":{"type":"migrate_job|cap_intake|rebalance_row|hold|no_action","params":{"job_id"?:string,"from_rack"?:string,"to_rack"?:string,"cap_w"?:number,"row"?:string},"one_line":string(<=90 chars)},"alternatives":[up to 2 action objects],"confidence":number 0..1,"learned_from":string|null}
- The action MUST satisfy every active constraint. Never target an excluded rack or an avoided row. Never move a pinned job.
- The target of a migrate MUST have headroom_w >= the job's power_w and stay within the power budget (draw_w + job power <= budget_w).
- CO-LOCATION: if the job has a co_located_with partner, migrate it to the rack HOSTING that partner, even if another rack has more headroom. Breaking co-location severely degrades the job, so never pick a rack just because it has the most headroom. If that rack is excluded by an operator constraint, pick the next-best feasible rack and say co-location could not be preserved.
- If an operator-added constraint shaped your choice, set learned_from to that constraint id (e.g. "c1"). Otherwise null.
- When a rack is over its cooling capacity, migrate its HIGHEST-priority job to a feasible target and cap the source rack intake to shed low-priority load. State both in one_line when both are needed.
- Terse operations English. No exclamation marks.
```

The CO-LOCATION rule and the power-budget requirement in the migrate rule are what make the demo's
contrast possible: the model is told, in the prompt, to prefer the partner's rack over the
emptiest rack, and code then verifies it did (section 4b). User message: the snapshot from
section 2.

The returned JSON is completed by code into a full `Advisory` (id, ts, origin="model"). Then
it goes through validation (section 4) before it is surfaced.

## 4. Two validation loops

### 4a. Schema validation (zod)

Parse the model content (strip a leading `<think>...</think>` defensively), `JSON.parse`, then
validate against `AdvisorySchema` (minus the code-filled fields). On failure, retry up to 2
times, each time appending to the user message the exact zod error text and
`"Your previous output was invalid: <error>. Return corrected JSON only."`. On the third
failure, emit the rule-based fallback (section 4c) with `origin: "auto"`.

### 4b. Action-feasibility validation (code, the trust mechanism)

Even a schema-valid advisory can be operationally wrong. Before surfacing, CODE checks the
proposed action against the live world and the active constraints:

```
validateAction(action, world, constraints) -> ok | violation(reason):
  migrate_job:
    for c in constraints:
      exclude_rack  & c.target == to_rack        -> violation("target " + to_rack + " excluded: " + c.reason)
      avoid_row     & c.target == row(to_rack)    -> violation("row " + row + " avoided: " + c.reason)
      pin_job       & c.target == job_id          -> violation("job " + job_id + " pinned: " + c.reason)
    if headroom_w(to_rack) < job.power_w          -> violation("target headroom " + hr + "W < job " + p + "W")
    if draw(to_rack) + job.power_w > budget(to_rack) -> violation("target would exceed power budget " + budget + "W")
    if job.co_located_with:                          # the co-location dependency
      partner_rack     = the rack currently hosting job.co_located_with
      partner_excluded = partner_rack is excluded by an operator constraint
      if partner_rack exists and not partner_excluded and to_rack != partner_rack
                                                   -> violation("breaks co-location: " + job_id + " must run with " + co_located_with + " on " + partner_rack)
    else ok
  cap_intake / rebalance_row / hold / no_action: ok if referenced racks exist
```

The co-location clause is what makes the greedy pick infeasible: while B3 (the partner's rack) is
available, any migrate of `job-4471` to a different rack is rejected, so a headroom-only answer of
B15 fails the check and gets re-prompted. Once the operator excludes B3, `partner_excluded` is
true, the clause goes quiet, and headroom governs the target again. On `violation`, re-prompt the
SAME model once more with the specific violation appended: `"That action is infeasible: <reason>.
Propose a different action that satisfies it."`. Allow up to 2 such feasibility re-prompts. If
still infeasible, fall back (4c). This loop is a key talking point: the model proposes, code
verifies against physics, the power budget, operator rules, and the co-location dependency, and
only a verified-feasible action ever reaches the engineer.

### 4c. Rule-based fallback (origin "auto")

Deterministic, always feasible, so the agent never goes silent. For a throttle-risk focus
rack: choose the migrate target as the constraint-satisfying rack with the greatest
`headroom_w` that fits the highest-power job and stays within budget; add `cap_intake` on the
focus rack. Candidates are filtered through the same `validateAction`, so the fallback also
honors co-location: when the job has a partner and that rack is not excluded, the partner rack is
the only one that passes the filter, so even the fallback lands on it. If no feasible target
exists, action is `hold` with a one_line explaining why. Mark `origin: "auto"` so the UI and our
honesty story distinguish it from a model advisory.

### 4d. The rule-vs-model contrast (rule_pick)

To make "the LLM does what a rule cannot" visible rather than asserted, code computes what a
naive headroom-only rule would have done and attaches it to the advisory as `rule_pick`
(`naiveHeadroomPick` in `inference.ts`, wired in by `Agent.computeRulePick`). The rule ignores
co-location and just grabs the emptiest constraint-satisfying rack. `rule_pick` is populated ONLY
when all of these hold: the model's action is a migrate of a job that has a co-location partner,
that partner's rack exists and is not excluded, and the naive pick both differs from the model's
target and would break the co-location. In every other case it is left unset, so the contrast is
honest and never manufactured. For the first B7 advisory it resolves to
`{to_rack: "B15", one_line: "Migrate job-4471 to B15 (most headroom, 5400W)", flaw: "breaks
job-4471's co-location with job-4470 on B3"}`, which the card renders under "a headroom-only rule
would". After the operator excludes B3, co-location is no longer achievable, so `rule_pick` is
unset on the re-solve and on the second event.

## 5. Override feedback and learning (the centerpiece)

An override is not a dismissal. It teaches the agent a durable rule.

1. The client sends `control/override` with a free-text `reason` and a structured
   `constraint {kind, target, reason}` (protocol.ts). For the demo: `exclude_rack B3`,
   reason "firmware update in 10 min".
2. The server assigns the constraint an id, `ts = sim_time_s`, `source = "override"`, and adds
   it to `world.constraints`. From now on it is printed in EVERY snapshot (section 2).
3. The overridden advisory's record is marked `outcome: "overridden"`, `operator_reason` set.
4. The server immediately re-solves for the same focus rack with `trigger: "override"`. Excluding
   B3 makes the co-location unreachable, so the constraint changes the criterion: with the
   dependency gone, the emptiest feasible rack is now correct and the re-solve routes `job-4471`
   to B15. The new advisory MUST set `learned_from` to the new constraint's id, and the UI
   renders a "learned: avoids B3" chip.
5. Every LATER advisory that would have been shaped by that constraint also sets `learned_from`
   to it and avoids the excluded target without being told again (the second S1 event proves
   this: A5 spikes with its own co-location on B3, and the agent routes around B3 on its own).

This closed loop, structured-constraint injection plus reconciliation plus the learned chip,
is what makes "the operator can override in the moment and the agent learns" real rather than
cosmetic.

## 6. Why

A separate heavy-tier call. Model, thinking-disabled settings as above,
`max_tokens: 220`, plain text (no JSON). System prompt:

```
You are Marshal explaining a recommendation to a shift engineer. In at most 3 sentences,
justify the current advisory using ONLY numbers from the snapshot (current temp, projected
temp, time to throttle, headroom). Cite specific values. Do NOT propose a new action or add
new advice. Terse operations English, no exclamation marks.
```

User message: the snapshot plus the advisory being questioned. Return the text via
`server -> why` (protocol.ts). Example shape: "B7 is at 68.7 C and projected to reach 84.5 C
within 5 minutes; time to throttle is 279 seconds. Its draw of 6300 W exceeds its 5670 W
cooling capacity by 630 W, so without shedding load it will cross the throttle line."

## 7. Resolution

When the incident's focus rack returns to nominal and no at-risk racks remain for that
incident, CODE composes a `Resolution` (protocol.ts) from the tracked incident timeline:
the advisories issued, the override and its learned constraint, the approved action, the
second event, and the final state. This is deterministic and needs no model call. An optional
one-line model summary is allowed but not required (keep it cuttable).

## 8. Agent voice

Terse operations English. Present tense for state, imperative for actions. No exclamation
marks, no hedging filler, no marketing. Headlines under 90 characters. Always cite numbers
when justifying. Examples:

- status: "Marshal watching 24 racks, cluster nominal, B-row utilization climbing"
- warn headline: "B7 hits 84 C throttle in ~5 min, migrate job-4471 to its partner on B3"
- action one_line: "Migrate job-4471 to B3 to join job-4470, cap B7 intake"
- learned chip: "learned: avoids B3 (firmware update in 10 min)"

## 9. Offline build

All of the above runs against the `MockProvider` (deterministic, keyed to S1 sim stages) when
`MOCK=1` or no key is present, so the whole app builds and the smoke test runs with no network.
The `CrusoeProvider` swaps in for the real demo. Same `Provider` interface, same validation
loops wrap both. See `src/inference/inference.ts`.
