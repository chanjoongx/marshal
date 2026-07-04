# CRUSOE_NOTES.md

How Marshal calls Crusoe Managed Inference from a Cloudflare Worker in TypeScript.
Upstream source of truth: `.claude/skills/CRUSOE.md` (full skill file, also mirrored to
`.cursor/rules/CRUSOE.md`). This file records only what our two models need, with the
Python patterns from CRUSOE.md translated to the exact TypeScript / JSON wire shape.
Anything marked **VERIFY** is confirmed by `scripts/probe.mjs` before we trust it.

## Endpoint and auth

- Base URL, exactly: `https://api.inference.crusoecloud.com/v1`
- We store it WITHOUT a trailing slash and always append `/chat/completions`, so the path
  is `.../v1/chat/completions` and never `.../v1//chat/completions` (double slash can 404).
- Auth header: `Authorization: Bearer <CRUSOE_API_KEY>`.
- A `429` almost always means a stale or wrong base URL, not a real rate limit. Check this
  exact string first before assuming throttling.
- The key can contain `$`. Never let a shell interpolate it. Write it straight into `.env`
  (gitignored). In the Worker it arrives as a secret binding, never inlined into a command.

## Our two models (locked strings, kept in env vars)

| Role | env var | Model string | Disable-thinking flag |
|---|---|---|---|
| Advisory (heavy reasoning) | `MODEL_ADVISORY` | `nvidia/NVIDIA-Nemotron-3-Ultra-550B` | `chat_template_kwargs: { enable_thinking: false }` |
| Risk classification (fast) | `MODEL_CLASSIFY` | `deepseek-ai/Deepseek-V4-Flash` | `chat_template_kwargs: { thinking: false }` |

These strings come from the workshop `server.py` `MODEL_MAP` and `_DISABLE_THINKING_BODY`
(CRUSOE.md section 11), the free-models list (section 1.4), and the LangGraph advisory
example (section 6). Two discrepancies exist in the doc and are handled:

- The catalog table writes `deepseek-ai/DeepSeek-V4-Flash` (capital S), but every code path
  uses `deepseek-ai/Deepseek-V4-Flash`. We use the code-path form. If the probe returns 404,
  retry the capital-S variant.
- The catalog table drops the `NVIDIA-` prefix (`nvidia/Nemotron-3-Ultra-550B`); the
  free-models list, the examples, and the integration configs all use
  `nvidia/NVIDIA-Nemotron-3-Ultra-550B`. We use the prefixed form. Probe confirms.

Because both are in env vars, swapping a string if the probe surprises us is one line.

## The extra_body -> JSON body mapping (the key TS translation)

In the Python OpenAI SDK, `extra_body={...}` merges its keys into the TOP LEVEL of the JSON
request body. So `chat_template_kwargs` is a top-level request field on the wire, not nested
under any `extra_body` key. CRUSOE.md section 9 confirms this in the DeepSeek V4 Pro note:
"chat_template_kwargs is passed as a TOP-LEVEL field, NOT inside extra_body." Enabling vs
disabling thinking differ in value, but both put `chat_template_kwargs` at the top level.

From TypeScript we POST this body with native `fetch` (no SDK needed on Workers):

```ts
// Nemotron Ultra advisory: thinking off, ask for JSON, low temperature
const body = {
  model: env.MODEL_ADVISORY,                     // nvidia/NVIDIA-Nemotron-3-Ultra-550B
  messages: [
    { role: "system", content: SYSTEM_PROMPT },  // byte-stable, stays cache-hot
    { role: "user", content: snapshotText },      // volatile world snapshot
  ],
  temperature: 0.2,
  top_p: 0.95,
  max_tokens: 900,
  chat_template_kwargs: { enable_thinking: false }, // TOP-LEVEL, not nested
  response_format: { type: "json_object" },         // VERIFY (see JSON section)
};

const res = await fetch(`${env.CRUSOE_BASE_URL}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${env.CRUSOE_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
const json = await res.json();
const content = json.choices?.[0]?.message?.content ?? "";
```

DeepSeek classification is the identical shape with `model: env.MODEL_CLASSIFY` and
`chat_template_kwargs: { thinking: false }` (note the different flag key: DeepSeek and Kimi
use `thinking`, Nemotron uses `enable_thinking`).

Why raw `fetch` instead of the OpenAI TS SDK: Workers `fetch` is native and dependency-free;
passing a non-standard top-level field through the typed SDK needs a cast anyway; raw fetch
keeps the wire shape auditable, which is exactly what the probe checks. If we ever use the
SDK, the same fields go into the `create()` argument object (cast to bypass types) and the
wire result is identical.

## Disabling thinking (required for structured output)

Both models are reasoning models. With thinking on they emit `<think>...</think>` or fill
`reasoning_content` and leave `content` empty or corrupted, which breaks JSON. Always
disable, per the table above. Confidence is high: CRUSOE.md section 3 once flagged the
DeepSeek flag as "assumed to match the Kimi pattern," but the workshop `server.py` ships
exactly this flag in `_DISABLE_THINKING_BODY`, so it is the intended path. The probe confirms
no leakage. Defensive parse anyway: strip a leading `<think>...</think>` block if present
before `JSON.parse`, then zod-validate.

## Requesting reliable JSON

Preference order, settled by the probe:

1. `response_format: { type: "json_object" }` plus a system instruction stating the exact
   schema and "output only valid minified JSON, no prose." vLLM (Crusoe's backend) supports
   json_object mode broadly.
2. If json_object is ignored or unreliable on Nemotron Ultra, use strict schema:
   `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }`.
   Gemma and Nemotron-Omni list `response_format` and `structured_outputs` as supported;
   Ultra's list is not published, hence VERIFY.
3. If both are weak: pure prompt-and-parse. Instruct JSON in the prompt, `JSON.parse`,
   zod-validate.

Regardless of which request hint wins, the provider always runs the validate-retry-fallback
loop: zod-validate the parsed object, and on failure retry up to 2 times echoing the exact
zod error back into the prompt, then emit a rule-based fallback advisory marked `auto`
(see AGENT_SPEC.md). Structured sampling: `temperature: 0.2`, `top_p: 0.95`. Keep
`max_tokens` tight (~900 advisory, ~40 classification) to cap latency and cost.

## Blocked parameters (403) - never send

- `top_k` -> 403. Use `temperature` + `top_p` only. It appears in some models' supported list
  but the managed API blocks it.
- `mm_processor_kwargs` -> 403 (vLLM-only). Not applicable to us (text-only).
- Any `extra_body` alongside `video_url` -> 403. Not applicable (text-only).
- General rule: an unexpected 403 with `"parameter '<name>' is not allowed"` means remove
  that non-standard field and retry. Standard OpenAI fields plus `chat_template_kwargs` plus
  `response_format` are safe.

## Error handling (bake into CrusoeProvider)

| Status | Meaning | Action |
|---|---|---|
| 401 `bad_credential` | key mangled by shell `$`, or expired / wrong project | We inject via env, never shell, so this should not occur. Surface clearly. |
| 404 `model not found` | wrong model string | Try the case / prefix variant noted above. |
| 404 `{"detail":"Not Found"}` | wrong base URL or path | Fix the URL. |
| 429 | usually a stale / wrong base URL | Verify the exact base URL FIRST. If correct, exponential backoff + lower max_tokens. Unlikely for us (1B token quota). |
| 412 `no available servers` | transient Crusoe orchestrator state | Wait 30-60s, retry the SAME model, do NOT switch. Provider does ONE retry with ~30s backoff. |
| streaming final chunk | empty `choices` | Guard every loop: `if (!chunk.choices?.length) continue;`. |

412 in the live loop: a persistent 412 must NOT block the sim. Surface
`agent_status: "reasoning temporarily unavailable, retrying"` and keep ticking; the advisory
lands when the retry succeeds. Demo mitigation: warm both models with a tiny call at Worker
startup so no cold 412 hits mid-recording.

For structured advisory and classification we use non-streaming requests and parse the whole
body, which sidesteps the streaming-chunk pitfall entirely. Streaming is only worth it for the
Why narrative if we want a typewriter feel, and then the guard above applies.

## Prompt caching (free performance)

Crusoe (MemoryAlloy) caches on repeated prefixes. Keep the system prompt byte-identical across
calls and put the volatile snapshot in the user message, so the system prefix stays cache-hot.
Cached input is roughly 4x cheaper and lowers TTFT.

## What the probe must confirm (scripts/probe.mjs)

1. Both model strings resolve (no 404); if 404, the variant fallback above.
2. `chat_template_kwargs` top-level disables thinking -> no `<think>` or `reasoning_content`
   leakage in `content`.
3. `response_format: { type: "json_object" }` yields parseable JSON that satisfies our
   Advisory zod schema; otherwise record which method (json_schema strict, or prompt-only)
   works, and make that the default.
4. Per-call latency for advisory and classification at these settings.
5. The single 412 retry path, if a 412 is encountered.

Record the winning request shape and latencies in README (Inference section).
