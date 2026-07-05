# PLAN.md

Marshal: a situational-awareness agent for a live GPU data center. It watches simulated rack
thermal telemetry, predicts rack-level throttling ~5 minutes ahead, and proposes one
constraint-aware job migration a non-technical shift engineer can approve, override, or
question. The rack view is context; the agent feed is the product.

RAISE Summit Hackathon, Crusoe track, built entirely July 4-5 2026. Solo, remote.

## Clock

Start of build: 2026-07-04 ~05:30 America/Los_Angeles. Hard deadline 2026-07-05 03:00
America/Los_Angeles (= 12:00 Europe/Paris). H at kickoff ~= 21.5 hours. Above the 12-hour
line, so full scope; nothing dropped up front. Cut ladder below if we fall behind.

## This is an agent console, not a dashboard

The rules ban any project whose main feature is a dashboard, and a data-center monitor is the
single highest dashboard risk. So the agent feed (Marshal's predictions, advisories, and
one-tap actions) is THE hero surface and holds visual priority. The rack heatmap is context
beside the feed, never the centerpiece. No standalone charts, gauges, or grids as the main
event. The framing everywhere: "an agent that watches and acts, with a rack view for context."
The word "dashboard" appears nowhere in the product or copy.

## Why the LLM is load-bearing (not replaceable by rules)

Code computes every number (temperatures, 5-minute projections, time-to-throttle, headroom).
The LLM does the part rules cannot: it reconciles conflicting operational constraints into one
executable migration. Where to move a job depends on the target rack's thermal headroom, the
job's priority and SLA, an operator-added maintenance window, the power budget, and job
dependencies, all at once. Encoding every combination as if-statements explodes; the model
reasons over the current state plus the active constraints plus the operator's learned
principles and returns one action, which code then validates for feasibility before surfacing.

## TypeScript is compliant

The workshop's Python 3.11+ requirement is for running the workshop's own example code, not a
rule binding participants; organizers confirmed the provided resources are useful but not
required. CRUSOE.md itself ships a TypeScript OpenAI SDK example. We build in TypeScript on
Cloudflare Workers and call Crusoe Managed Inference over its OpenAI-compatible HTTP endpoint,
which is all the Crusoe track requires.

## Architecture

```
 React client  <--- WebSocket --->  Cloudflare Worker
 (agent feed hero,                   -> Durable Object: MarshalSession
  rack heatmap context)                 - seeded sim engine (thermal ODE, scheduler)  [CURSOE]
                                         - agent loop (tick -> classify -> advise -> validate)
                                         - session state (constraints, effects, advisories)
                                         - Provider (Mock | Crusoe)                    [ME: contract]
                                              |
                                              v
                                     Crusoe Managed Inference (OpenAI-compatible)
                                       - nvidia/NVIDIA-Nemotron-3-Ultra-550B  (advisory, Why)
                                       - deepseek-ai/Deepseek-V4-Flash        (risk classify)
```

- One Durable Object instance per session holds the world and runs a ticking alarm. It
  broadcasts `tick`/`advisory`/`agent_status`/`resolution`/`why` to connected WebSocket
  clients and accepts `control` actions (protocol.ts).
- All inference is called from the Worker via `fetch` (never Python). Thinking disabled,
  structured JSON, per docs/CRUSOE_NOTES.md.
- MOCK=1 (default) runs the deterministic MockProvider so the whole app builds and the smoke
  test runs offline. The real demo sets MOCK=0 with the API key secret.

## File layout ([ME] = I own it as contract, [CURSOR] = implements)

```
.claude/skills/CRUSOE.md          [ME]     official Crusoe skill (source of truth)
.cursor/rules/CRUSOE.md           [ME]     same file, for Cursor
docs/CRUSOE_NOTES.md              [ME]     TS request shapes, thinking flags, error rules
docs/SIM_SPEC.md                  [ME]     thermal model + constants + S1 scenario (cited)
docs/AGENT_SPEC.md                [ME]     trigger policy, snapshot, validation loops, prompts
PLAN.md README.md REVIEW.md       [ME]
src/shared/types.ts               [ME]     domain model + zod + SIM constants
src/shared/protocol.ts            [ME]     WebSocket contract + zod
src/inference/inference.ts        [ME]     Provider interface, MockProvider, CrusoeProvider,
                                           validateAction, ruleBasedAdvisory, renderSnapshot
scripts/curve_check.mjs           [ME]     thermal oracle (proves the constants)
scripts/probe.mjs                 [ME]     verifies Crusoe inference against our schema
tests/smoke.spec.ts               [ME]     Playwright end-to-end of the S1 demo path
src/server/index.ts               [CURSOR] Worker entry + WebSocket routing
src/server/session.ts             [CURSOR] MarshalSession Durable Object
src/server/sim.ts                 [CURSOR] thermal engine + scheduler, matches SIM_SPEC + oracle
src/server/agent.ts               [CURSOR] tick -> classify -> advise -> validate loops
src/server/*.test.ts              [CURSOR] vitest units (see Testing)
src/client/**                     [CURSOR] React app: agent feed hero + rack heatmap context
vite.config.ts, index.html        [CURSOR] client + Worker dev wiring (Cloudflare Vite plugin)
```

Cursor adds client dependencies (react, react-dom, vite, the Cloudflare Vite plugin) and, if
needed, a src/server tsconfig with @cloudflare/workers-types. The root tsconfig covers the
shared and inference layers.

## What is already done vs what Cursor implements

Done (this repo, before Cursor starts):
- All contracts: types, protocol, SIM_SPEC, AGENT_SPEC, CRUSOE_NOTES.
- Inference interface + a complete deterministic MockProvider + a CrusoeProvider whose request
  shape follows CRUSOE_NOTES (confirmed by the probe before the demo).
- Pure decision helpers: validateAction (feasibility) and ruleBasedAdvisory (fallback).
- The thermal oracle (curve_check) with the tuned constants, all checks passing.

Cursor implements, against these contracts:
- The seeded sim engine (thermal ODE + scheduler) matching SIM_SPEC and the oracle.
- The MarshalSession Durable Object: tick loop, session state, WebSocket broadcast.
- The agent loop wiring the two validation loops and the override/learning path from AGENT_SPEC.
- The React client: agent feed as hero, rack heatmap as context, approve/override/why controls,
  the SIMULATED TELEMETRY badge, and the Nemotron-via-Crusoe footer.
- vitest units.

I do not edit the app. I review it against the specs and record drift in REVIEW.md with
file:line refs.

## Timebox (H ~= 21.5h, scaled)

- Done: Step 0 + contracts + oracle + scaffold (this stretch).
- Next: push public repo, hand Cursor prompt B, run the probe when the key arrives, finalize
  CrusoeProvider + README inference section.
- Parallel while Cursor builds: DEMO_SCRIPT.md, PITCH.md, SUBMISSION.md.
- Mid-build: review Cursor's sim + agent loop; REVIEW.md.
- When it runs: smoke.spec.ts green; re-run curve_check against the real engine's output.
- Last 90 min: ship ritual (check green, README top, tag v1.0.0, record video, submit).

## Cut ladder (drop in this order if behind)

1. Gradium TTS stretch. 2. Scenario S2. 3. Cloudflare deploy (local run is fine; the video is
the artifact). 4. Animation extras. Never cut: S1, real Crusoe Nemotron inference,
constraint-based override learning, the action-feasibility validation loop, Why, the smoke
test, the video, the README, the public repo.

## Testing

- tests/smoke.spec.ts [ME], Playwright: MOCK=1, start S1 at 8x, assert an advisory fires before
  B7 throttles, override in plain language to exclude B3, assert a later advisory shows the
  learned chip and does not target B3, assert B7 projected temp drops after Approve.
- vitest units [CURSOR]: thermal integration matches curve_check, 5-min projection, action
  effects on temperature, validateAction against constraints/headroom/budget, trigger debounce.
- `npm run check` = typecheck + vitest. `npm run curve` = the thermal oracle.

## Checkpoints

1. CRUSOE_API_KEY: paste it and I run the probe (project Marshal, expiry 2026-07-06).
2. Confirm I should hand Cursor prompt B once the contracts are pushed.
3. Later: the video URL and the submission form fields.
