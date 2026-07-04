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
minutes, because the new load exceeds its cooling headroom by 630 watts. That projection is
real physics: temperature has thermal inertia, so five minutes ahead is a legitimate forecast,
not a straight line. The advisory is one action: migrate B7's high-priority job to a rack with
headroom and cap its intake."

Trust and override (50s). "The engineer can ask why, and Marshal answers with the actual
numbers, current temp, projected temp, time to throttle, headroom. No new advice, just the
justification. Now the engineer knows something the telemetry does not: the rack Marshal chose
is in maintenance. They override in plain language. Marshal turns that into a structured
constraint, re-solves in seconds onto another rack with headroom, and shows a 'learned' chip. Approve, and B7's
projected temperature bends back down, away from the throttle line."

Learning (30s). "Watch what happens on the next event. A different row spikes. Marshal routes
around the excluded rack on its own, without being told again, and the advisory carries the same learned
chip. The override did not just fix one incident, it changed how the agent reasons."

Close (20s). "Every number here is computed by code. The language model does the part rules
cannot: reconciling a target's headroom, a job's priority, a maintenance window, and the power
budget into one feasible action, which code validates before the engineer ever sees it. The
reasoning runs on NVIDIA Nemotron via Crusoe Managed Inference. The telemetry is simulated; the
agent, the inference, and the learning are real. This is exactly the GPU-cluster problem Crusoe
runs every day."

## Prepared answers

Why is this not a dashboard? The hero surface is the agent feed: predictions, advisories, and
one-tap actions. The rack heatmap is context beside it, never the centerpiece, and there are no
standalone charts as the main event. A dashboard shows you state and leaves the decision to
you; Marshal makes the prediction, proposes the action, and defends it. Remove the heatmap and
the product still works; remove the feed and there is nothing.

Why is the LLM load-bearing, not replaceable by rules? Because the decision is constraint
reconciliation, not a threshold. Choosing where to migrate depends on the target's thermal
headroom, the job's priority and SLA, operator-added constraints like a maintenance window, the
power budget, and dependencies, all at once. Encoding every combination as if-statements
explodes and cannot absorb a new operator rule mid-shift. The model reasons over the current
state plus the active constraints plus what it has learned, and returns one action. Code does
every calculation; the model does the judgment.

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
later decision inherits it. That is why the second event routes around the maintenance rack
without being told again.

How does the feasibility loop prevent bad migrations? After the model proposes an action, code
checks it against the live world and the active constraints: the target must not be excluded or
avoided, the job must not be pinned, and the target must have enough headroom and stay within
budget. If it fails, we re-prompt the model with the specific violation. Only a verified action
reaches the engineer, and if the model keeps failing there is a deterministic, always-feasible
fallback marked as such. The model proposes; code guarantees.

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
