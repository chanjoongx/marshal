# Marshal

An agent that predicts GPU rack thermal throttling before it happens and proposes one
constraint-aware job migration a shift engineer can approve, override, or question. The agent
feed is the product; the rack heatmap is context beside it. Not a dashboard.

Built entirely during the RAISE Summit Hackathon, July 4-5 2026. Crusoe track. Solo, remote.

## What it is, in 20 seconds

A live GPU data center pod throws a batch surge onto a row. One rack's cooling headroom is
exceeded, so its GPU temperature will cross the 84 C throttle line in a few minutes. Marshal sees
it coming from the projection, not after the fact, draws a live forecast of that rack heading for
the throttle line, and issues an advisory. The twist is where it moves the job: the hot rack's
high-priority job must stay co-located with its gradient partner on another rack, so Marshal sends
it there rather than to the emptiest rack, and the card shows side by side that a headroom-only
rule would have grabbed the emptiest rack and broken the dependency. The engineer can ask "why"
and get the numbers, or override in plain language with a real-world constraint the telemetry
cannot know ("that rack has a firmware update in ten minutes"). Marshal interprets that note into a
structured constraint, reconciles it, re-solves in seconds, the forecast bends away from the
throttle line on approve, and it remembers the rule for every later decision.

## Real vs simulated

Honesty matters for judging, so the boundary is explicit and shown in the UI.

- Real: the agent loop, Crusoe Managed Inference on NVIDIA Nemotron-3-Ultra-550B, the
  constraint reconciliation (including a job's co-location dependency), the model turning a
  plain-language operator override note into a structured constraint (code validates the target
  against the live world), the live temperature forecast the agent draws, the override-to-learning
  loop, and the action-feasibility validation that rejects an infeasible migration before it
  reaches the engineer. The advisory card also shows, side by side, what a headroom-only rule
  would have done, so the model's advantage is demonstrated rather than claimed.
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
- `deepseek-ai/Deepseek-V4-Flash` gives a cheap per-rack risk second opinion that only orders
  which flagged rack to advise first. Code owns the authoritative triage: the projection decides
  in code which racks escalate to the heavy model, so it fires rarely and the classifier can never
  suppress a real throttle.

Verified against the live endpoint with `npm run probe` (8/8 checks pass):

- Both model strings resolve as written: `nvidia/NVIDIA-Nemotron-3-Ultra-550B` and
  `deepseek-ai/Deepseek-V4-Flash`.
- Thinking disabled via a top-level `chat_template_kwargs` field (`enable_thinking:false` for
  Nemotron, `thinking:false` for DeepSeek). No reasoning leaked into content.
- Structured JSON via `response_format: {type:"json_object"}` validates against our Advisory
  zod schema on Nemotron Ultra; no json_schema-strict fallback was needed.
- Constraint reconciliation works on the real model: excluding a rack makes the advisory route
  to a different rack and set `learned_from`.
- Natural-language override interpretation works on the real model, including notes that name a
  rack only by description. The model is given the live rack and job list, so it resolves a
  description to the correct id, which a regex cannot: "the rack running the checkpoint writer" ->
  `exclude_rack B3`, "take the marginal-cooling rack out of rotation" -> `exclude_rack B7`. A regex
  can pull "B3" out of an id-bearing note but has nothing to grab in a description, so that
  resolution is the load-bearing step. The probe parses 5/5 notes into the right constraint, 2 of
  them description-only, across all three kinds `exclude_rack`, `avoid_row`, `pin_job`
  (`node scripts/probe_constraint.mjs`). Code then validates the resolved target against the live
  world, with a deterministic regex fallback, so a mis-parse cannot invent a phantom rack.
- Co-location reasoning works on the real model, not just the mock: when a job carries a
  `co_located_with` dependency on its gradient partner, Nemotron migrates it to the partner's rack
  (B3) over the emptiest rack (B15) in 3/3 runs, and adapts to another rack once B3 is excluded
  (`node scripts/probe_reasoning.mjs`). This is what the on-screen rule-vs-model contrast reports.
- Latency: classification ~0.8-1.1s, advisory ~2.5-4.6s, Why ~0.9-1.2s.

The same two-tier inference has been run end to end on the deployed Cloudflare Worker
(https://marshal.neverboringnow.workers.dev) with real Crusoe inference, not only locally.

The exact request shape and error rules are in docs/CRUSOE_NOTES.md; the provider is in
src/inference/inference.ts.

## Track and bonus

- Track: Crusoe. The build is exactly the Crusoe track's Statement Three example: a GPU cluster
  agent that fuses telemetry to predict rack-level thermal throttling and surfaces a one-tap
  migration a non-technical operator can trust and override.
- NVIDIA bonus: the advisory reasoning runs on NVIDIA Nemotron, so this also qualifies for the
  best-creative-use-of-Nemotron prize.

## License

MIT. See LICENSE.
