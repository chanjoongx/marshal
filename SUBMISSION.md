# SUBMISSION.md

Paste-ready material for the RAISE Summit Hackathon submission form.

## Form fields

**Team Name:** `Marshal`

**Team Members:** Chanjoong Kim (`chanjoongx`), solo.

**Competed:** Remotely.

**Track:** Crusoe.

**Public GitHub Repository:** https://github.com/chanjoongx/marshal

**1 Minute Demo Video:** https://youtu.be/WtLlCCnGc3o

**Bonus prize tracks (select only the ones actually used):**
- [x] NVIDIA (advisory, Why, and override interpretation run on Nemotron-3-Ultra-550B)
- [x] Cloudflare (deployed on Workers + Durable Objects, the stateful WebSocket runtime)
- [ ] Microsoft for Startups, Nebius, OpenRouter, SUSE: not used, leave unchecked.

## Project Description

Marshal is a situational-awareness agent for GPU data center operations, built on Crusoe Managed Inference. It constructs a live thermal model from streaming rack telemetry, predicts rack-level throttling about five minutes before it hits a specific rack, and surfaces one plain-language advisory a non-technical shift engineer can approve, question, or override in the moment. It is an agent, not a dashboard: the rack view is context, the proactive advisory is the product.

Code computes every number (a first-order thermal model gives the five-minute forecast; the model never does arithmetic). The language model does what a rule cannot, shown on screen rather than claimed: it keeps a job co-located with its gradient partner instead of migrating to the emptiest rack, beside the flawed pick a headroom-only rule would make; and it interprets a free-text override, even one that names a rack only by description ("the rack running the checkpoint writer has a firmware update"), into a structured constraint it then learns from for every later decision.

Advisory reasoning runs on NVIDIA Nemotron-3-Ultra-550B with a DeepSeek-V4-Flash triage tier via Crusoe Managed Inference, deployed live on Cloudflare Workers and Durable Objects. Built entirely during RAISE Summit Hackathon 2026 (Crusoe track, solo, remote). Rack telemetry is simulated; the agent, the inference, and the learning are real.

## YouTube upload

**Title:**
> Marshal — GPU rack thermal-throttling agent | RAISE Summit Hackathon 2026 (Crusoe track)

**Description:**
> Marshal is a situational-awareness agent for GPU data center operations, built entirely during RAISE Summit Hackathon 2026 (Crusoe track, solo, remote).
>
> It builds a live thermal model from streaming rack telemetry, predicts rack-level throttling about five minutes before it hits a specific rack, and surfaces one plain-language advisory a shift engineer can approve, question, or override in the moment. It is an agent, not a dashboard: the rack view is context, the proactive advisory is the product.
>
> What the language model does that a rule can't, shown on screen:
> - Keeps a job co-located with its gradient partner instead of moving it to the emptiest rack, next to the flawed pick a headroom-only rule would make.
> - Interprets a free-text override, even one that names a rack only by description ("the rack running the checkpoint writer has a firmware update"), into a structured constraint it then learns from for every later decision.
>
> Code computes every number (a first-order thermal model gives the forecast; the model never does arithmetic). Advisory reasoning runs on NVIDIA Nemotron-3-Ultra-550B with a DeepSeek-V4-Flash triage tier via Crusoe Managed Inference, deployed on Cloudflare Workers and Durable Objects.
>
> Rack telemetry is simulated; the agent, the inference, and the learning are real.
>
> Crusoe track, Statement Three: an agent that builds a live situational model from streaming inputs and drives proactive actions an operator can trust, question, and override. Bonus tracks: NVIDIA (Nemotron) and Cloudflare (Workers + Durable Objects).

## Rules compliance check (verify before submitting)

- Public repo: github.com/chanjoongx/marshal must be PUBLIC (private = disqualified).
- Agent, not a dashboard: framed agent-first everywhere (the proactive advisory is the product; the rack view is context). "Any project where a dashboard is the main feature" is a listed disqualifier.
- Built during the event: solo, new, from scratch during RAISE 2026; stated in the description and video.
- Demo over presentation (Demo = 50%, and the rules say "please do not show us a presentation"): the video leads with and is mostly the live working app; the deck is a short frame only, not half the runtime.
- Track fit: Crusoe Statement Three, almost verbatim (predict rack-level throttling before it hits specific racks; a recommendation a shift engineer can override; learns from each override).

## Feedback fields

**Crusoe:**
Crusoe Managed Inference was the backbone and held up well for a real-time agent: OpenAI-compatible so no SDK needed, Nemotron-3-Ultra-550B and DeepSeek-V4-Flash both available and fast (advisory ~3s), and structured JSON via response_format validated cleanly. A few sharp edges cost time and a short "gotchas" note next to the model list would fix them: (1) a 412 "no available servers" on a cold model reads like a hard error but is transient, so how to detect and back off should be documented; (2) disabling thinking for clean JSON needed a top-level chat_template_kwargs (enable_thinking:false for Nemotron, thinking:false for DeepSeek), which wasn't obvious; (3) top_k returned 403; (4) exact model-string casing was ambiguous. Overall genuinely usable for production-style inference, thank you.

**Cursor:**
Cursor was great for turning a written spec into typed contracts and deterministic sim/agent code quickly, and the fast model kept the loop tight. Most useful when the spec was precise and the types were the source of truth.

**Organizers:**
Thanks for a well-run event. The track statements were concrete enough to build directly against (the Crusoe track's Statement Three is exactly what I shipped), and free access to real sponsor models made it possible to build something genuinely live, remotely. Clear judging criteria and a simple submission flow helped a lot.

**Google DeepMind / Vultr:** not used in this build, leaving blank.

---

## 1-minute demo video

Format: two 30-second halves. First 30s = live footage of the deployed app (MOCK=0, so the green `Nemotron · Xs` chip is on screen). Second 30s = the 5-slide deck. Record each screen silent, voice each half as its own ElevenLabs clip, and lay each over its matching footage. Slide 1 (title) is a 2-3s cold open before the demo, or the thumbnail.

### Part A narration, over the live app (~30s)

> GPU racks throttle under heat, and operators find out after one has already slowed down. Marshal predicts it, catching B7 five minutes before it throttles. Notice it doesn't send the job to the emptiest rack; it keeps it with its partner on B3, and shows the pick a plain rule gets wrong. Then the engineer types a note in plain language, and Nemotron turns it into a hard constraint. Approve, and the forecast bends back under the line.

Sync: "predicts it / catching B7" over the climbing forecast and the first advisory; "keeps it with its partner on B3 / plain rule gets wrong" over the advisory card and the rule-vs-model box; "types a note / turns it into a constraint" over the override panel and the re-solve with its learned chip; "Approve, and the forecast bends" over the approve and the curve dropping. (The second A5 event is optional silent footage; do not narrate it.)

### Part B narration, over the 5-slide deck (~30s)

> So, why a model and not a rule? A rule just grabs the emptiest rack. The model reconciles real constraints and reads plain language, while code owns every number, so the forecast is real physics. It runs on NVIDIA Nemotron and DeepSeek through Crusoe, on Cloudflare. The telemetry is simulated; the agent is real.

Sync: slide 2 (the problem) on "a rule just grabs the emptiest rack"; slide 3 (why a model) on "reconciles real constraints and reads plain language"; slide 4 (architecture) on "code owns every number ... Crusoe ... Cloudflare"; slide 5 (closing) on "telemetry simulated; the agent is real".

### Slides (dark, background #0a0d12 to match the app)

- Title: big "MARSHAL", subtitle "predicts GPU rack thermal throttling before it happens", small "agent console for GPU data center ops, Crusoe track".
- Closing: "Code computes every number. The LLM does what rules can't: reconcile constraints + interpret plain language." then "NVIDIA Nemotron-3-Ultra-550B + DeepSeek-V4-Flash, Crusoe Managed Inference" then "Cloudflare Workers + Durable Objects, live at marshal.neverboringnow.workers.dev".

### Recording checklist (verified live end to end with scripts/drive.mjs, both events)

- Warm the models right before recording: `npm run probe` (green) so no cold 412 mid-take.
- Open the deployed URL fresh, 1920x1080. Speed 8x reaches the action fast; drop to 1x while you type the override so the sim does not race ahead, then back to 8x.
- Click path: Start S1 -> first advisory in ~15-20s (co-location to B3, the rule-vs-model box, the climbing forecast) -> Why -> Override, type "the rack running the checkpoint writer has a firmware update in 10 min" (the killer beat; fall back to "B3 has a firmware update in 10 min" if the live model stumbles) -> the re-solve appears with a learned chip -> Approve and the forecast bends from ~83C back under the nominal line (~69C) with a resolution card -> ~30s later a second rack (A5) hits the same wall and Marshal handles it honoring the learned rule -> Approve -> resolution.
- The re-solve and the second event may show a power cap OR a migration live (the model varies run to run); both correctly avoid B3 and bend the curve, so narrate action-agnostically ("handles it", "holds it under throttle"), never "the emptiest rack".

## Notes for judges (real vs simulated)

- Real: the agent loop, Crusoe Nemotron inference, constraint reconciliation (including a job's co-location dependency), the plain-language override interpretation, the override-to-learning loop, and the action-feasibility validation. Live advisories carry a `Nemotron · Xs` latency chip; the offline mock is labeled `simulated model`.
- Simulated: rack telemetry and the cluster, via a cited first-order thermal model. A permanent `SIMULATED TELEMETRY` badge is always shown.
