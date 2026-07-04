# Marshal

An agent that predicts GPU rack thermal throttling before it happens and proposes one
constraint-aware job migration a shift engineer can approve, override, or question. The agent
feed is the product; the rack heatmap is context beside it. Not a dashboard.

Built entirely during the RAISE Summit Hackathon, July 4-5 2026. Crusoe track. Solo, remote.

## What it is, in 20 seconds

A live GPU data center pod throws a batch surge onto a row. One rack's cooling headroom is
exceeded, so its GPU temperature will cross the 84 C throttle line in a few minutes. Marshal
sees it coming from the projection, not after the fact, and issues an advisory: migrate the
hot rack's high-priority job to a rack with headroom and cap its intake. The engineer can ask
"why" and get the numbers, or override with a real-world constraint the telemetry cannot know
("that rack is in maintenance"). Marshal reconciles the constraint, re-solves in seconds, and
remembers it for every later decision.

## Real vs simulated

Honesty matters for judging, so the boundary is explicit and shown in the UI.

- Real: the agent loop, Crusoe Managed Inference on NVIDIA Nemotron-3-Ultra-550B, the
  constraint reconciliation, the override-to-learning loop, and the action-feasibility
  validation that rejects an infeasible migration before it reaches the engineer.
- Simulated: the rack telemetry and the cluster. A first-order thermal model (cited GPU specs,
  see docs/SIM_SPEC.md) gives temperatures real physical inertia, which is what makes a
  5-minute prediction legitimate. A permanent `SIMULATED TELEMETRY` badge is always visible.

## How to run

```
npm install
npm run curve          # thermal oracle: proves the sim constants (no network)
npm run check          # typecheck + unit tests
# offline app (MockProvider, no key):
MOCK=1 npm run dev
# real Crusoe inference:
#   put CRUSOE_API_KEY in .dev.vars, set MOCK=0, then `npm run dev`
```

Inference details (models, latency, verified request shape) are filled in from the probe:
see the Inference section below and docs/CRUSOE_NOTES.md.

## Inference

Two-tier, both on Crusoe Managed Inference (OpenAI-compatible), called from the Cloudflare
Worker, thinking disabled for structured output:

- `nvidia/NVIDIA-Nemotron-3-Ultra-550B` generates the advisory and the Why explanation.
- `deepseek-ai/Deepseek-V4-Flash` does cheap per-rack risk classification so the heavy model
  fires rarely.

Probe results (latency, JSON reliability, final request shape) recorded here after
`npm run probe`.

## Track and bonus

- Track: Crusoe. The build is exactly the Crusoe track's Statement Three example: a GPU cluster
  agent that fuses telemetry to predict rack-level thermal throttling and surfaces a one-tap
  migration a non-technical operator can trust and override.
- NVIDIA bonus: the advisory reasoning runs on NVIDIA Nemotron, so this also qualifies for the
  best-creative-use-of-Nemotron prize.

## License

MIT. See LICENSE.
