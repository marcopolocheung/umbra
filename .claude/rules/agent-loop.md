---
paths:
  - "app/lib/agent/**"
  - "app/hooks/useAgent.ts"
  - "app/components/AssistantPanel.tsx"
  - "api/agent.js"
---

# The Umbra Assistant

An assistant that only ever says things the map can back up. Narrow and grounded is the
product; a fluent assistant that occasionally invents a street is worth less than nothing here.

## The budget is the design constraint

The LLM is **Google Gemini free tier only**, capped per key per minute and per day. Every key
goes into one comma-separated shared pool (`VITE_GEMINI_API_KEY`, numbered `_1/_2/_3` in dev,
`_1..._9` in prod); the client in dev and `api/agent.js` in prod round-robin the pool and fail
over on 429/5xx and 401/403. There is no per-role key split — all roles draw the one pool.
A real turn costs a median of 4 LLM calls (C6 live eval; 6.2 before it). What holds it
there: research ends at the model's first successful `plot_points`, and the loop draws a
route through the pins when the user asked for one; `check_shadow` takes every spot in one
call; an identical repeated call is answered from the earlier result, not re-run, and
search closes after four per turn (an empty search steers a reformulation — it never
closes search); non-empty geocodes, searches and shadow checks are cached for the session
(`useAgent`'s `cache`). Empty searches are deliberately never cached: a miss now must not
veto a retry later.

**Adding an LLM round-trip is a real cost, not a refactor.** The 5/min ceiling is what makes
latency user-visible.

## Determinism is load-bearing

`temperature 0`, a fixed `seed`, `parallel_tool_calls: false`, `MAX_STEPS` 8, and a tightly
scoped system prompt. `MAX_STEPS` is 8 because the happy path needs about five tool turns to
get through `plot_points` — lowering it strands the loop before pins reach the map.

**`get_current_context` is deliberately not a tool.** Map centre, local time and
location-known status are plain app state, so `agentLoop.ts` reads them once per turn and
appends them to the system prompt, saving a guaranteed round-trip. New ambient context should
follow that pattern rather than becoming another tool.

## Per-role models, one key pool

Research runs with `VITE_GEMINI_RESEARCH_MODEL`, the final answer with
`VITE_GEMINI_RESPONSE_MODEL` (default `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`). If both resolve
to the same model, `rolesShareConfig()` skips the separate write call — the research answer
*is* the answer. Research makes many small tool-calling turns, which is why it gets the
lighter model; the one write call gets the stronger one.

The write call uses a **separate, tool-free system prompt** so a reasoning model cannot
narrate uncallable tools into the answer. Keep tool names out of it.

## Grounding

The loop collects `pointCandidates` during research and runs `plotFallbackPoints()` before the
write phase, injecting a "map state guarantee" line. This exists because the assistant used to
narrate itineraries it never plotted. **It has never been confirmed in a browser** (issue #59)
— do not describe it as proven.

Anything concrete in an answer — a street, a time, a percentage, a place name — must trace to
a tool result. When a tool fails or returns nothing, the answer says so; silent degradation is
an ungrounded claim.

Shadow queries must not move the camera. `check_shadow` tries `queryPointShadow()` (camera-free,
geometry cache), falls back to `queryOffscreenBuildingShadow()`, and errors rather than flying.
Only `locate_user` and `plot_points` legitimately move the map.

## Architecture

The loop runs **client-side** — it orchestrates tools that need the live map canvas
(geocoding, the solar model, on-canvas shadow sampling, time and camera control, the routing
pipeline). It speaks one neutral IR (`LlmContent`/`LlmPart`); `llmClient.ts` translates to and
from the OpenAI chat-completions shape Gemini's compatible endpoint expects — no `seed`, and
each tool call's thought signature carried back as `functionCall.extra`. Keep provider
specifics inside `llmClient.ts` — the loop should not know what Gemini is.

Changes here need tests: `app/lib/__tests__/` already covers `agentLoop`, `agentTools` and
`agentProxy`, and the suite is hermetic — no network, no env. Keep it that way.
