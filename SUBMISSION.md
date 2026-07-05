# SUBMISSION.md

Paste-ready material for the RAISE Summit Hackathon submission form.

## Form fields

**Team Name:** `Marshal`

**Team Members:** Chanjoong Kim (`chanjoongx`), solo.

**Competed:** Remotely.

**Track:** Crusoe.

**Public GitHub Repository:** https://github.com/chanjoongx/marshal

**1 Minute Demo Video:** (record and paste the YouTube-unlisted or Loom URL; script below)

**Bonus prize tracks (select only the ones actually used):**
- [x] NVIDIA (advisory, Why, and override interpretation run on Nemotron-3-Ultra-550B)
- [x] Cloudflare (deployed on Workers + Durable Objects, the stateful WebSocket runtime)
- [ ] Microsoft for Startups, Nebius, OpenRouter, SUSE: not used, leave unchecked.

## Project Description

Marshal is a situational-awareness agent for GPU data center operations. It watches streaming rack telemetry, predicts rack-level thermal throttling about five minutes before it happens, and proposes ONE constraint-aware fix a non-technical shift engineer can approve, override, or question in the moment.

Code computes every number: a first-order thermal model anchored on H100 specs gives temperatures real inertia, so the five-minute forecast is legitimate, not a straight-line guess. The language model does what rules cannot, and Marshal shows it on screen rather than claiming it. First, it keeps a job co-located with its gradient partner instead of migrating to the emptiest rack, next to the flawed pick a headroom-only rule would make. Second, it interprets a plain-language override the operator types, even one that names a rack only by description ("the rack running the checkpoint writer"), into a structured constraint, then re-solves and learns it for every later decision.

Advisory reasoning runs on NVIDIA Nemotron-3-Ultra-550B (with a DeepSeek-V4-Flash triage tier) via Crusoe Managed Inference, deployed live on Cloudflare Workers and Durable Objects. Rack telemetry is simulated; the agent, the inference, and the learning are real.

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

Format: a title slide (about 5s), then live product footage of the deployed app (about 45s), then a closing slide (about 10s). Record the product screen silent, then lay the ElevenLabs voice narration and the two slides over it in an editor, synced to the beats below. Record with MOCK=0 (or just record the deployed URL) so the green `Nemotron · Xs` chip is on screen.

### Narration (for ElevenLabs, ~60s)

> [0-6s, title slide] GPU data centers lose real money to thermal throttling, and today operators mostly find out after a rack has already slowed down.
>
> [6-15s, app: console + surge + forecast] Marshal predicts it. A batch surge hits rack B7, and five minutes before it throttles, Marshal draws the forecast and raises one advisory.
>
> [15-28s, app: advisory card + rule contrast] Here's the interesting part. It doesn't move the hot job to the emptiest rack. That job has to stay co-located with its gradient partner on B3, so Marshal sends it there, and shows you the pick a plain headroom rule would have made, and why it's wrong.
>
> [28-42s, app: free-text override] Now the engineer knows something the telemetry doesn't. They type it in plain language: the rack running the checkpoint writer has a firmware update. Nemotron reads the live racks, resolves that to B3, and turns the sentence into a hard constraint. A regex can't do that.
>
> [42-50s, app: re-solve + learned chip + second event] Marshal re-solves in seconds, learns the rule, and when a second rack hits the same wall, it handles that one on its own, applying what you just taught it.
>
> [50-60s, closing slide] Every number is code. The model does the part rules can't: reconcile constraints, and understand language. It runs on NVIDIA Nemotron via Crusoe Managed Inference, on Cloudflare Workers. The telemetry is simulated; the agent is real.

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
