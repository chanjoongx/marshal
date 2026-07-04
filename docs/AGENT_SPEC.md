# AGENT_SPEC.md

How Marshal turns the simulated world into proactive, trustworthy advisories. This is the
contract for the agent loop, the two-tier inference, the snapshot format, the validation
loops, and the exact prompts. Types are in `src/shared/types.ts`; the inference interface is
in `src/inference/inference.ts`; Crusoe request mechanics are in `docs/CRUSOE_NOTES.md`.

Core claim this spec makes true: the LLM does the part rules cannot. It reconciles conflicting
operational constraints (a target rack's thermal headroom, a job's priority and SLA, a
maintenance window an operator added, the power budget) into one executable migration a
non-technical engineer can run. Code computes every number; the LLM never does arithmetic.

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
target racks (healthy racks with the most headroom), not all 24, to stay compact.

Format (exact, deterministic ordering):

```
SNAPSHOT t=<sim_time_s>s
CLUSTER: <cluster_note>
FOCUS: <focus_rack_id>   TRIGGER: <band_cross|override|why|resolution>
RACKS:
  id   temp  proj5m  ttt    headroom_w  band     util%  draw_w  jobs
  B7   68.7  84.5    279s   -630        nominal  95     6300    job-4471(high,700W); batch-1(low,560W); batch-2(low,560W)
  B12  47.3  47.5    -      +5500       nominal   32     2600    svc-2201(normal,900W); ...
  B15  50.0  50.2    -      +5100       nominal   40     3000    ...
QUEUE: pending=[job-5540(low,560W)->B-row]; recent=[job-4471->B7@120s]
CONSTRAINTS (operator-added, active - you MUST satisfy all):
  - [c1] exclude_rack B12  reason="B12 in maintenance"  @186s
RECENT ADVISORIES (last 3, with outcome):
  - warn B7  action="migrate job-4471 to B12; cap B7 intake"  -> overridden ("B12 in maintenance")
```

If there are no constraints, print `CONSTRAINTS: none`. The constraint block is the point:
it is what turns advice generation into constraint reconciliation.

## 3. The advisory call (Tier 3)

Model `nvidia/NVIDIA-Nemotron-3-Ultra-550B`, thinking disabled
(`chat_template_kwargs: { enable_thinking: false }`), `temperature: 0.2`, `top_p: 0.95`,
`max_tokens: 900`, `response_format: { type: "json_object" }` (see CRUSOE_NOTES for the
verify-in-probe caveat).

System prompt (byte-stable, do not vary between calls):

```
You are Marshal, a situational-awareness agent for a live GPU data center. You watch rack
thermal telemetry and propose ONE executable action a non-technical shift engineer can
approve, override, or question. You never do arithmetic: every number you need is given in the
snapshot. Your job is to reconcile the operator's active constraints and each rack's physical
limits (headroom_w and power budget) into a single feasible recommendation.

Rules:
- Output ONLY minified JSON matching this schema, no prose, no markdown:
  {"severity":"watch|warn|critical","area":string,"headline":string(<=90 chars),
   "rationale":string(2 sentences, cite >=2 numbers from the snapshot),
   "action":{"type":"migrate_job|cap_intake|rebalance_row|hold|no_action",
             "params":{"job_id"?,"from_rack"?,"to_rack"?,"cap_w"?,"row"?},
             "one_line":string(<=90 chars, an instruction the engineer can execute)},
   "alternatives":[up to 2 action objects],"confidence":number 0..1,
   "learned_from":string|null}
- The action MUST satisfy every active constraint. Never target an excluded rack or an
  avoided row. Never move a pinned job.
- The target of a migrate MUST have headroom_w >= the job's power_w and stay within budget.
- If an operator-added constraint shaped your choice, set learned_from to that constraint id
  (e.g. "c1"). Otherwise null.
- Terse operations English. No exclamation marks. Prefer migrating high-priority jobs and
  shedding or capping low-priority load.
```

User message: the snapshot from section 2.

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
    if draw(to_rack) + job.power_w > budget(to_rack) -> violation("target over power budget")
    else ok
  cap_intake / rebalance_row / hold / no_action: ok if referenced racks exist
```

On `violation`, re-prompt the SAME model once more with the specific violation appended:
`"That action is infeasible: <reason>. Propose a different action that satisfies it."`. Allow
up to 2 such feasibility re-prompts. If still infeasible, fall back (4c). This loop is a key
talking point: the model proposes, code verifies against physics and operator rules, and only
a verified-feasible action ever reaches the engineer.

### 4c. Rule-based fallback (origin "auto")

Deterministic, always feasible, so the agent never goes silent. For a throttle-risk focus
rack: choose the migrate target as the constraint-satisfying rack with the greatest
`headroom_w` that fits the highest-power job and stays within budget; add `cap_intake` on the
focus rack. If no feasible target exists, action is `hold` with a one_line explaining why.
Mark `origin: "auto"` so the UI and our honesty story distinguish it from a model advisory.

## 5. Override feedback and learning (the centerpiece)

An override is not a dismissal. It teaches the agent a durable rule.

1. The client sends `control/override` with a free-text `reason` and a structured
   `constraint {kind, target, reason}` (protocol.ts). For the demo: `exclude_rack B12`,
   reason "B12 in maintenance".
2. The server assigns the constraint an id, `ts = sim_time_s`, `source = "override"`, and adds
   it to `world.constraints`. From now on it is printed in EVERY snapshot (section 2).
3. The overridden advisory's record is marked `outcome: "overridden"`, `operator_reason` set.
4. The server immediately re-solves for the same focus rack with `trigger: "override"`. The new
   advisory reconciles the constraint (re-routes off B12 to B15) and MUST set
   `learned_from` to the new constraint's id. The UI renders a "learned: <reason>" chip.
5. Every LATER advisory that would have been shaped by that constraint also sets `learned_from`
   to it and avoids the excluded target without being told again (the second S1 event proves
   this: A-row spikes, the agent routes around B12 on its own).

This closed loop, structured-constraint injection plus reconciliation plus the learned chip,
is what makes "the operator can override in the moment and the agent learns" real rather than
cosmetic.

## 6. Why

A separate heavy-tier call. Model, thinking-disabled settings as above,
`max_tokens: 220`, plain text (no JSON). System prompt:

```
You are Marshal explaining a recommendation to a shift engineer. In at most 3 sentences,
justify the current advisory using ONLY numbers from the snapshot (current temp, rate or
projected temp, time to throttle, headroom). Cite specific values. Do NOT propose a new
action or add new advice. Terse operations English, no exclamation marks.
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
- warn headline: "B7 projected to hit 84 C throttle in ~5 min, batch load exceeds cooling"
- action one_line: "Migrate job-4471 to B15 and cap B7 intake"
- learned chip: "learned: avoids maintenance racks"

## 9. Offline build

All of the above runs against the `MockProvider` (deterministic, keyed to S1 sim stages) when
`MOCK=1` or no key is present, so the whole app builds and the smoke test runs with no network.
The `CrusoeProvider` swaps in for the real demo. Same `Provider` interface, same validation
loops wrap both. See `src/inference/inference.ts`.
