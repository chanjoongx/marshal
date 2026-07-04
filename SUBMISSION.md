# SUBMISSION.md

Paste-ready material for the submission form
(https://cerebralvalley.ai/e/raise-summit-hackathon/hackathon/submit).

## Description (150 words)

Marshal is a situational-awareness agent for live GPU data center operations. It watches
streaming rack telemetry, predicts rack-level thermal throttling about five minutes before it
happens, and proposes one constraint-aware job migration a non-technical shift engineer can
approve, override, or question in the moment. Code computes every number: a first-order thermal
model anchored on H100 SXM5 specs gives temperatures real physical inertia, so the five-minute
projection is legitimate. The LLM does what rules cannot: it reconciles conflicting operational
constraints, a target rack's headroom, a job's priority, an operator-added maintenance window,
the power budget, into a single feasible action, which code validates before surfacing. When an
engineer overrides ("that rack is in maintenance"), Marshal adds a structured constraint,
re-solves in seconds, and applies it to every later decision. Advisory reasoning runs on NVIDIA
Nemotron-3-Ultra-550B via Crusoe Managed Inference. Rack telemetry is simulated; the agent,
inference, and learning are real.

## Tech used (mark on the form)

- Crusoe Managed Inference (OpenAI-compatible endpoint)
- NVIDIA Nemotron-3-Ultra-550B (advisory + Why reasoning)  <- flag NVIDIA tech used
- DeepSeek-V4-Flash (fast risk classification tier)
- Cloudflare Workers + Durable Objects (stateful agent + WebSocket)
- React + TypeScript (agent console)
- zod (typed contracts)

## Links

- Repo (public, MIT): https://github.com/chanjoongx/marshal
- Live deployment (Cloudflare Worker + Durable Object, real Nemotron inference): https://marshal.neverboringnow.workers.dev
- Demo video (1 min): TBD  <- paste YouTube-unlisted or Loom URL here before submitting

## Form fields

- Track: Crusoe
- NVIDIA bonus: yes, advisory reasoning runs on NVIDIA Nemotron-3-Ultra-550B (best creative use
  of Nemotron)
- Cloudflare bonus: yes, deployed live on Cloudflare Workers + Durable Objects (the stateful
  WebSocket agent runtime), calling real Crusoe inference from the Worker.
- Built during event: yes. Built entirely during the RAISE Summit Hackathon, July 4-5 2026.

## Notes for judges (real vs simulated)

- Real: the agent loop, Crusoe Nemotron inference, constraint reconciliation, override learning,
  and the action-feasibility validation loop.
- Simulated: rack telemetry and the cluster, via a cited first-order thermal model. A permanent
  SIMULATED TELEMETRY badge is shown in the UI.
