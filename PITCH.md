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
something the telemetry does not: B3 has a firmware update in ten minutes. They override in plain
language. Marshal turns that into a structured constraint and re-solves in seconds; with the
co-location no longer reachable, headroom is now the right call, so it routes to B15 and shows a
'learned: avoids B3' chip. Approve, and on the forecast B7's projection bends back down, away from
the throttle line."

Learning (30s). "Watch the next event. A different aisle spikes, and its hot job happens to want
the same partner on B3. But B3 is excluded now, so Marshal routes around it on its own, without
being told again, carrying the same learned chip. The override did not just fix one incident, it
changed how the agent reasons."

Close (20s). "Every number here is computed by code. The language model does the part rules
cannot: reconciling a target's headroom, a job's priority, a job's co-location dependency, a
maintenance window, and the power budget into one feasible action, which code validates before
the engineer ever sees it. The reasoning runs on NVIDIA Nemotron via Crusoe Managed Inference.
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

Why is the LLM load-bearing, not replaceable by rules? We demonstrate it on screen rather than
assert it. When B7 overheats, its hot job has a co-location dependency: it must run on the same
rack as its gradient partner or the distributed training run degrades. A headroom-only rule does
the obvious thing and migrates to B15, the emptiest rack, which breaks that co-location. The
model instead migrates to B3, the partner's rack, even though B3 has far less headroom. The card
puts both picks side by side: the rule's B15 with its flaw spelled out, next to the model's B3.
Then the operator excludes B3 for a firmware window, the co-location becomes impossible, and the
model adapts, now headroom is the right criterion so it routes to B15 on its own. Encoding every
such combination as if-statements explodes and cannot absorb a new operator rule mid-shift. Code
does every calculation; the model does the judgment, and code validates that judgment against
physics, the power budget, and the constraints before the engineer sees it. This holds on the
real model, not just the mock: a reasoning probe picks B3 three times out of three and adapts to
another rack when B3 is excluded.

What is simulated, and why is the thermal model credible? The rack telemetry and cluster are
simulated; a permanent badge says so. The model is first-order lumped-capacitance heat transfer
(Newton's law of cooling): each rack's temperature moves toward a load-dependent steady state
with a tuned time constant, so it has real inertia. Constants are anchored on the H100 SXM5
(700W TDP, junction throttle in the low-to-mid 80s C) and data-center rack densities we cite in
SIM_SPEC. That inertia is exactly what makes a five-minute prediction physical rather than a
gimmick, and we tuned the time constant with a headless oracle so the curve is reproducible.

How does an override change future reasoning? It is not a dismissal. The override becomes a
structured constraint (kind, target, reason) that is injected into every future snapshot the
model sees. The next advisory must reconcile it and set a learned_from reference, and every
later decision inherits it. That is why the second event routes around B3 on its own, even though
its job wants the same co-location partner, without being told again.

How does the feasibility loop prevent bad migrations? After the model proposes an action, code
checks it against the live world and the active constraints: the target must not be excluded or
avoided, the job must not be pinned, the target must have enough headroom and stay within budget,
and a job with a co-location partner must land on the partner's rack unless that rack is excluded.
That last check is what rejects the greedy B15 pick while B3 is still available. If it fails, we
re-prompt the model with the specific violation. Only a verified action reaches the engineer, and
if the model keeps failing there is a deterministic, always-feasible fallback marked as such. The
model proposes; code guarantees.

Why is this Crusoe's actual problem? Crusoe is energy-first AI infrastructure and runs GPU data
centers as its core business. The Crusoe track's own Statement Three names this example: a GPU
cluster agent that fuses power, cooling, and scheduler signals to predict rack-level thermal
throttling and surface a one-tap migration a non-technical operator can trust and override that
learns from each override. We built exactly that, on their inference.

Why Nemotron? The advisory is the high-stakes, multi-constraint reasoning step, which is where
the largest reasoning model earns its cost; the cheap DeepSeek tier gates it so it fires rarely.
Running the advisory on NVIDIA Nemotron also qualifies for the NVIDIA bonus with the same build.

What breaks at real cluster scale, and the path there? Three things. One, telemetry: swap the
simulator for real power, cooling, and scheduler feeds; the agent loop and contracts do not
change. Two, the thermal model: replace the lumped-capacitance approximation with per-rack
learned thermal response fit from historical data. Three, action execution: wire approve to the
real scheduler and cooling controls with an audit trail, and keep the human in the loop until
confidence is proven. The feasibility validation and the constraint memory are exactly the
safety scaffolding that a real rollout needs.
