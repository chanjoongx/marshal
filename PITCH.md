# PITCH.md

3-minute live-demo pitch and the prepared answers. Demo is the artifact; talk over the
product, not slides.

## 3-minute script

Open (20s). "This is Marshal. It is an agent that watches a live GPU data center and acts
before things go wrong. Not a monitor you stare at, an agent that predicts a problem and hands
the on-shift engineer one decision. Right now it is watching 24 racks, and B-row utilization is
climbing."

Predict (40s). "A scheduler burst just landed a batch on B-row. Rack B7 is still in the safe
range, but Marshal is already projecting it will cross its 84C throttle line in about five
minutes, because the new load exceeds its cooling headroom by 1260 watts. You can see it on the
forecast Marshal draws: B7's measured line climbing, its five-minute projection reaching for the
throttle line. That projection is real physics, temperature has thermal inertia, so five minutes
ahead is a legitimate forecast, not a straight line. The advisory is one action, and here is the
interesting part. It does not send the job to the emptiest rack. B7's hot job has to stay
co-located with its gradient partner on B3, so Marshal migrates it to B3 and caps B7's intake."

Trust and override (50s). "Right on the card, Marshal shows what a plain headroom rule would have
done: migrate to B15, the rack with the most headroom, which would break the co-location and
degrade the training run. That contrast is the point, the rule optimizes one number, the model
reconciles the dependency. The engineer can ask why, and Marshal answers with the actual numbers,
current temp, projected temp, time to throttle, headroom, no new advice. Now the engineer knows
something the telemetry does not: B3 has a firmware update in ten minutes. They type that into a
single field in plain language, no form, no dropdown: 'B3 has a firmware update in 10 min.' Marshal
interprets that sentence live into a structured constraint, exclude_rack B3, checks B3 is a real
rack, and re-solves in seconds; with the co-location no longer reachable, headroom is now the right
call, so it routes to a feasible high-headroom rack that avoids B3 and shows a 'learned: avoids rack B3' chip. Approve, and on the forecast
B7's projection bends back down, away from the throttle line."

Learning (30s). "Watch the next event. A different aisle spikes, and its hot job happens to want
the same partner on B3. But B3 is excluded now, so Marshal routes around it on its own, without
being told again, carrying the same learned chip. The override did not just fix one incident, it
changed how the agent reasons."

Close (20s). "Every number here is computed by code. The language model does the two parts rules
cannot: reading the operator's plain-language note into a structured constraint, and reconciling
that against a target's headroom, a job's priority, a job's co-location dependency, and the power
budget into one feasible action, which code validates before the engineer ever sees it. The reasoning runs on NVIDIA Nemotron via Crusoe Managed Inference.
The telemetry is simulated; the agent, the inference, and the learning are real. This is exactly
the GPU-cluster problem Crusoe runs every day."

## Prepared answers

Why is this not a dashboard? The hero surface is the agent feed: predictions, advisories, and
one-tap actions. The rack heatmap is context beside it, never the centerpiece. The one chart, the
forecast, lives inside the feed as the agent reasoning out loud, not a monitoring widget: it
appears only while a rack is heading for throttle, and its projection bends away the moment you
approve, so it is arguing for a decision rather than sitting there as state. A dashboard shows you
state and leaves the decision to you; Marshal makes the prediction, proposes the action, and
defends it. Remove the heatmap and the product still works; remove the feed and there is nothing.

Why is the LLM load-bearing, not replaceable by rules? Take the sharpest case first, because it is
where a rule provably fails. When the operator names a rack by id, "B3 has a firmware update in 10
minutes", a regex can pull "B3" out and a model is not strictly required. But operators also name
things by description, "the rack running the checkpoint writer has a firmware update", and there a
regex has nothing to grab. The model reads the live rack and job list, maps the checkpoint-writer
job (ckpt-9) to B3, and returns exclude_rack B3. That resolution from a description to the correct id
against the current world is the one step no fixed rule can do, and it is exactly what an operator
needs mid-shift. The constraint probe shows it on the real model: 5 of 5 notes parsed into the right
structured constraint, including 2 description-only notes a regex cannot resolve ("the rack running
the checkpoint writer" to exclude_rack B3, "take the marginal-cooling rack out of rotation" to
exclude_rack B7), via `node scripts/probe_constraint.mjs`. The same model also turns an ordinary note
into one machine-readable rule, a kind of exclude_rack, avoid_row, or pin_job plus a target and a
short reason: "don't put anything on row A" becomes avoid_row A, "leave job-4471 where it is" becomes
pin_job job-4471. Code then checks the resolved target against the live world, the rack or row or job
must actually exist, and if the parse does not validate it falls back to a deterministic regex that
pulls a rack id out of the note, so a mis-parse can never invent a phantom rack.

The model's second job is reconciling that constraint together with the job's co-location dependency
and the rack physics into one feasible action, and we show that on screen rather than assert it.
When B7 overheats, its hot job must run on the same rack as its gradient partner or the distributed
training run degrades. A headroom-only rule migrates to B15, the emptiest rack, which breaks that
co-location; the model migrates to B3, the partner's rack, even though B3 has far less headroom, and
the card puts both picks side by side. Then the operator excludes B3 for a firmware window, the
co-location becomes impossible, and the model adapts, now headroom is the right criterion so it
routes to a feasible high-headroom rack that avoids B3 on its own. Encoding every such combination as if-statements explodes and cannot
absorb a new operator rule mid-shift. Code does every calculation and enforces feasibility,
validating that the target exists and re-checking the action against physics, the power budget, and
the constraints; the model does the language understanding and the judgment. This holds on the real
model, not just the mock: the constraint probe parses five of five, two of them description-only,
and a reasoning probe picks B3 three times out of three and adapts to another rack when B3 is
excluded.

What is simulated, and why is the thermal model credible? The rack telemetry and cluster are
simulated; a permanent badge says so. The model is first-order lumped-capacitance heat transfer
(Newton's law of cooling): each rack's temperature moves toward a load-dependent steady state
with a tuned time constant, so it has real inertia. Constants are anchored on the H100 SXM5
(700W TDP, junction throttle in the low-to-mid 80s C) and data-center rack densities we cite in
SIM_SPEC. That inertia is exactly what makes a five-minute prediction physical rather than a
gimmick, and we tuned the time constant with a headless oracle so the curve is reproducible.

How does an override change future reasoning? It is not a dismissal. The operator types a
plain-language note, the model interprets it into a structured constraint (kind, target, reason),
and code validates the target against the live world before trusting it. That constraint is then
injected into every future snapshot the model sees. The next advisory must reconcile it and set a
learned_from reference, and every later decision inherits it. That is why the second event routes
around B3 on its own, even though its job wants the same co-location partner, without being told
again.

How does the feasibility loop prevent bad migrations? After the model proposes an action, code
checks it against the live world and the active constraints: the target must not be excluded or
avoided, the job must not be pinned, the target must have enough headroom and stay within budget,
and a job with a co-location partner must land on the partner's rack unless that rack is excluded.
That last check is what rejects the greedy B15 pick while B3 is still available. If it fails, we
re-prompt the model with the specific violation. Only a verified action reaches the engineer, and
if the model keeps failing there is a deterministic, always-feasible fallback marked as such. The
model proposes; code guarantees.

Why migrate instead of a power or clock cap first? For a bare imminent throttle, a DVFS power or
clock cap is the standard first move, and we would not argue otherwise. This case is not that. The
scheduler surge landed job-4471 on B7, separating it from its gradient partner job-4470 on B3, so
the migration is not a throttle dodge, it restores a co-location the scheduler broke: moving
job-4471 to B3 both relieves B7 and puts the two jobs back together, which a power cap cannot do.
And the approved action already caps the source rack's intake, so it is cap-plus-migrate, not
migrate-alone. Where there is no co-location to restore, a pure throttle is better served by a power
cap first, and a real DVFS power-cap action is on the roadmap.

Why is this Crusoe's actual problem? Crusoe is energy-first AI infrastructure and runs GPU data
centers as its core business. The Crusoe track's own Statement Three names this example: a GPU
cluster agent that fuses power, cooling, and scheduler signals to predict rack-level thermal
throttling and surface a one-tap migration a non-technical operator can trust and override that
learns from each override. We built exactly that, on their inference.

Why Nemotron? The advisory is the high-stakes, multi-constraint reasoning step, which is where the
largest reasoning model earns its cost. Code, not the cheap model, is the gate: the projection
decides in code which racks escalate to Nemotron, so it fires rarely and nothing a classifier says
can suppress a real throttle. The DeepSeek tier is a fast, cheap second opinion that only orders
which flagged rack to advise first. Running the advisory on NVIDIA Nemotron also qualifies for the
NVIDIA bonus with the same build.

What breaks at real cluster scale, and the path there? Three things. One, telemetry: swap the
simulator for real power, cooling, and scheduler feeds; the agent loop and contracts do not
change. Two, the thermal model: replace the lumped-capacitance approximation with per-rack
learned thermal response fit from historical data. Three, action execution: wire approve to the
real scheduler and cooling controls with an audit trail, and keep the human in the loop until
confidence is proven. The feasibility validation and the constraint memory are exactly the
safety scaffolding that a real rollout needs.
