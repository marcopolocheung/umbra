# Track C — Shadow Copilot

> **Charter:** an assistant that only ever says things the map can back up. Narrow, grounded,
> and fast enough to be worth asking — the questions Gemini can't answer because it doesn't
> model shadow at 5:40pm on this block.

**Class:** Flagship. **Runs alongside:** everything. This track owns `app/lib/agent/**` outright
and reaches the rest of the app only through tool wrappers — it is the friendliest track to
run in parallel with any other.

---

## Current state

- **Active checkpoint:** C4 — the terminal plan job contract. C3 may proceed independently when
  its ShadowField inputs are ready; C5 follows C4's result shape.
- **Done in the inspected Track C/public head:** C1, C2, C6, walking-radius place search, and the
  empty-search reformulation fix. The scenario index contains 34 cases. Do not reopen the old
  one-empty-search closeout; exact-call deduplication plus the four-search budget is the current
  policy.
- **The route now gets requested and drawn**, including ordered `via` stops. That does not close
  C4: the tool still reports “started” rather than observing a terminal calculation result.
- **The LLM is now Google Gemini** (free tier, three-key pool; owner's decision 2026-09-11 after
  Cerebras failed). Defaults are `gemini-3.5-flash-lite` for research and
  `gemini-3.1-flash-lite` for response. The older Fireworks numbers remain historical baselines.
- **Live eval:** `npm run eval:agent` — see `docs/notes/agent-live-eval-2026-09-11.md`. The recorded
  Gemini comparison reports 25/25 place-to-pin consistency on its default-model run; C6 later
  recorded 30/30 with a median four LLM calls. Name this metric precisely—directions, shadow,
  time, and terminal route claims were not graded and are C5/C13 work.
- **Last verified:** 2026-09-14 at public commit `8b6bce1`; 69 focused agent/tool/client/proxy
  tests passed locally. The project declares Node 24; a full run under Node 20 produced worker
  runtime errors after 765 passing assertions, so use the declared runtime for the full gate.

---

## What's already true (verified 2026-08-24 — do not "fix" these)

The archived `PROJECT_REVIEW-2026-07-05.md` lists three agent failures. Two have since been addressed:

1. **"Narrates itineraries it never plots"** — `agentLoop.ts:155-170` now collects
   `pointCandidates` during research and runs `plotFallbackPoints()` before the write phase,
   which calls `plot_points` and injects a *"Map state guarantee: the app already plotted
   these itinerary pins before answering"* line into the write prompt. **It has never been
   confirmed in a browser** (issue **#59**). C1 + C2 are about *locking it down*, not building it.
2. **"`check_shadow` hijacks the camera for 10–15s"** — no longer true. `tools.ts:359-390`
   tries `ctx.shadowLayerRef.current.queryPointShadow()` (camera-free, geometry cache), falls
   back to `queryOffscreenBuildingShadow()` (Overpass, viewport-independent), and errors out
   rather than flying. The only remaining camera moves are `locate_user` (`:282`) and
   `plot_points` (`:422`, `:435`) — both legitimate.
3. **"Two-point routes only"** — no longer true. `plan_shadowed_route` accepts ordered `via`
   stops and writes them to `additionalWaypoints`. C4 is now the terminal result/version boundary,
   not multi-stop input.

Also already built and worth knowing before you touch anything:

- **7 exposed tools** (`tools.ts`): `locate_user` (115), `geocode_place` (120), `search_places` (131),
  `check_shadow` (146), `set_time` (160), `plot_points` (171), `plan_shadowed_route` (195);
  `get_current_context` is *not* a tool — it's pre-injected into the system prompt each turn
  (`agentLoop.ts:141-150`) to save a guaranteed round-trip.
- **Two-model roles**: research (`gemini-3.5-flash-lite`) then write
  (`gemini-3.1-flash-lite`, tool-free prompt at `agentLoop.ts:44`). `rolesShareConfig()` skips
  the second call when they're the same model.
- **Determinism**: temperature 0, fixed seed, `parallel_tool_calls: false`, `MAX_STEPS = 8`.
- **Resilience**: round-robin key pool with 429/5xx failover (client and `api/agent.js`),
  Retry-After handling, malformed-tool-call retry, and `extractTextToolCalls` salvage for
  models that emit calls as prose.

## Hard invariants that bite this track

- **No paid inference.** Google Gemini, capped per key per minute and per day. No second LLM
  provider or key pool, no chatty calls. A 5-step turn can take over a minute purely on rate
  limits — that budget is a design constraint, not an inconvenience. C14 may use a free durable
  deployment store for cross-instance quotas/release state; if no suitable store is available,
  durable quota acceptance remains unmet rather than being simulated in process memory.
- **The loop runs client-side** because its tools need the live map (canvas, camera, routing
  pipeline). Don't move it server-side; `api/agent.js` is a key-hiding proxy, not a host.
- **One neutral IR.** `LlmContent`/`LlmPart` in, OpenAI chat-completions out via `llmClient.ts`.
  Provider details stay in that one file.
- Both current models emit a `reasoning` field; `fromOpenAI` reads `content`. Reasoning-heavy
  models eat the token budget on tool calls — that's why research ≠ write.

## The contract this track publishes

Tools, and only tools. **Every tool is a thin wrapper that delegates** — to `ShadowField`
(Track A), the routing pipeline (Track E), `HeatModel` (Track D), or a service wrapper.
If a tool contains domain logic, it's in the wrong file.

## The agent-capstone evidence bar

This brief now distinguishes **a good assistant feature** from **a portfolio-complete applied-AI
system**. C1/C2/C6 already make the loop substantially better than a prompt wrapper. They do not,
by themselves, close the evidence bar below.

For the completed Umbra capstone to be strong enough to identify an unusually complete applied-AI
and Geo SWE candidate, all of these must be observable in code and measurement:

1. **Outcome correctness:** C4 returns a terminal, versioned plan result; C5 verifies claims
   against typed receipts; C11 repairs typed plans without silently rebuilding them.
2. **Independent evaluation:** C13 separates development regressions from held-out tasks, repeats
   stochastic runs, includes a controlled real-tool tier, and reports confidence intervals and
   cost per successful task.
3. **Code-enforced safety:** C10 treats provider text and image text as untrusted data; C14 makes
   models, prompts, tool schemas, budgets, deployment, monitoring, and rollback server-owned and
   versioned.
4. **Genuine multimodality:** C12 sends images to Gemini, makes region-linked visual claims, and
   compares the image-conditioned agent with offline and non-agent baselines at equal budgets.
5. **A real ML lifecycle:** Track A's A10 owns the observed-shadow dataset, learned component,
   geographic/temporal holdouts, model artifact, deployment, drift checks, and rollback. C12 may
   consume its evidence through a thin tool; Track C must not hide that work inside an executor.
6. **Defensible Geo algorithms:** H1–H7 own time-dependent constrained search, an exact oracle,
   and an LP/convex relaxation; H6 exposes the result through C4's job protocol. Thin delegation
   is the architecture, while the trace from tool call to algorithm and bound is the evidence.
7. **Accessible operation:** C15 makes dialog, focus, progress, errors, receipts, and completed
   plans operable and understandable with keyboard and screen-reader workflows; G5 supplies the
   automated baseline.

Tenure, credentials, public packaging, and multi-person ownership remain resume/publication
questions, not implementation gates in this track. Completion of the bar is not permission to
claim employment duration or universal production scale. It is the point at which the repository
can honestly support a much stronger claim: **built and evaluated a secure, accessible,
multimodal Geo agent over a versioned ML and optimization stack, with terminal actions and
measured failure modes.**

---

## Checkpoints

### C1 — Eval harness **first**
**Goal.** Make agent behavior testable without a network or a key.
**Approach.** `app/lib/agent/__tests__/scenarios/`: the initial ~15 scenarios have grown to 34;
each is a scripted
sequence of model responses (the existing `agentLoop.test.ts` / `agentProxy.test.ts` already
stub the client — extend that pattern). Assert **behavior, not prose**:
- did `plot_points` run before the write phase, in the happy path *and* the step-budget-exhausted path?
- does the final answer name only places that were plotted?
- did the loop stay within `MAX_STEPS` and within a tool-call budget?
- does a tool error produce an honest answer rather than a confident invention?
- does an empty `search_places` result stop the loop from inventing a café?
**Acceptance.** Runs in `npm test`, no network, deterministic. A deliberately broken loop
(e.g. `plotFallbackPoints` disabled) makes it fail — prove the harness has teeth by trying it.
**Files.** `app/lib/agent/__tests__/**`. **Size.** Large. **Gate: nothing else in this track ships first.**

### C2 — Ground the write phase
**Goal.** Close the remaining gaps in plot-before-answer, and verify **#59** for real.
**Approach.** With C1 in place, find where the guarantee leaks: candidates collected but not
plotted (dedupe/cap at 8), places named in prose that never became candidates, the
`separateWrite === false` path (research model answers directly — does the guarantee still
hold there?). Tighten the write prompt to forbid naming unplotted places, and enforce in code
what the prompt asks for.
**Acceptance.** Every C1 grounding scenario green, including the shared-model path; #59's two
observations confirmed in `npm run dev` and the issue closed with what was actually observed.
**Files.** `agentLoop.ts`, `tools.ts`. **Size.** Medium.

### C3 — Probes on the `ShadowField`
**Goal.** One shadow source for the whole app.
**Approach.** `check_shadow` calls Track A's `ShadowField.shadowAt` and reports `source` +
`confidence` in the tool result, so the model can qualify its answer ("shadowed, though tree
cover here is estimated"). Keeps the Overpass path as fallback. Adds `check_shadow_at_times`
over `sweep` (A6) so "when is this terrace shadowed?" costs one tool call, not five.
**Acceptance.** No camera movement during research (already true — keep it that way, and add
a C1 scenario that asserts it); confidence surfaces in the answer; a low-confidence probe never
becomes a confident sentence.
**Files.** `tools.ts`. **Size.** Small–medium. **Needs A2/A6; stub until then.**

### C4 — The plan job contract  *(re-scoped 2026-09-07)*
**Multi-stop already shipped.** `plan_shadowed_route` takes ordered `via` stops and drives
`setAdditionalWaypoints` (`tools.ts:207-219`, `:456-466`). The earlier framing of this
checkpoint was stale. What is actually missing is the boundary underneath it.

**Goal.** A tool call that reports what *happened*, not that something was *started*.
**The defect.** The executor sets waypoints, `await delay(50)`, calls `ctx.calculateRoute()`,
and immediately returns `{ ok: true, note: "Route calculation started…" }` (`tools.ts:470-478`).
So **tool-call success is not plan success**: the loop cannot distinguish a finished route from
one that failed, was superseded, or never resolved, and the model writes its answer either way.
That is the single clearest correctness gap in this track, and it undercuts the product's first
stated value — *trustworthy*.
**Approach.** Return a job handle and resolve it: a `requestId`, the input version, and a
terminal status (`completed | partial | no_plan_found | cancelled | error`) carrying the route
metrics and `shadowProvenance` on success. Feed resolution from the routing pipeline's existing
streaming completion rather than a longer `delay`. Bind mutations to an expected plan version
and an idempotency key so a stale calculation cannot overwrite a newer one. Surface cancellation
and provider failure as **states**, not a tool row that spins forever. Prefer Track E's `Trip`
(E5) as the argument shape once it exists; add `suggest_time` backed by A6's sweep and Track D's
best-time series **after** the contract lands, not before.
**Acceptance.** A C1 scenario asserts that a failed or cancelled calculation surfaces as a
terminal non-success status the model can read and does not narrate as success; a superseded
calculation cannot overwrite a newer plan; a leg that can't be routed reports honestly
(`partialRoute.ts` already models this) rather than being silently dropped.
**Files.** `tools.ts`, `agentLoop.ts`, thin call into `useNavigation`'s pipeline via
`AgentContext`. **Size.** Medium. **Unblocks H6.**
**Why this is the highest-value applied-AI item on the board:** *"tool call succeeded"* versus
*"the outcome happened"* is the correctness question in agent engineering, and this repo has a
clean, real instance of getting it wrong — which makes fixing it a better story than never
having had the bug.

### C5 — Answers with receipts
**Goal.** Every externally checkable claim is either backed by typed evidence or explicitly
unknown — not merely every place name clickable.
**Approach.** Produce structured claims alongside prose. A `ClaimReceipt` has a stable claim id,
claim kind (`place | shadow | time | route | accessibility`), normalized subject, value/unit,
tool-result id, source/version, observation or validity time, confidence, and map-object id. A
deterministic verifier runs after generation and before display. It rejects or rewrites claims
whose receipt is absent, stale, type-incompatible, or contradicted by the terminal plan. Prose is
presentation; the receipt graph is the correctness object.

`AssistantPanel` renders accessible chips such as “Shadow 62% at 16:00 — checked” that focus the
matching map object and expose the evidence, method, uncertainty, and age. A place result cannot
support a shadow percentage; a shadow probe cannot support a route-completion claim; a photograph
of an apparent obstruction cannot certify present accessibility.
**Acceptance.** Every named place, numeric shadow/time statement, route-status statement, and
accessibility statement is either linked to a compatible receipt or worded as unknown. Injected
unsupported claims fail the suite. Clicking a receipt focuses the right object without losing
keyboard focus. The eval reports separate place, shadow, temporal, route, and accessibility
support rates plus unsupported-claim escapes; it never compresses them into one ambiguous
“grounded” score. Zero escapes is required on the deterministic suite, and held-out performance
is reported with failures under C13.
**Files.** `agentLoop.ts`, `AssistantPanel.tsx`, `useAgent.ts`, typed receipt/validator modules,
scenarios. **Size.** Large.

### C6 — Budget discipline
**Goal.** Fit the free tier and feel alive while doing it.
**Approach.** Per-session caches for geocode/search results (identical queries recur constantly);
collapse redundant probes; stream tool progress to the panel ("checking 3 spots…" — `onToolEvent`
already exists); consider a cheap deterministic pre-pass for obviously-geocodable inputs.
**Acceptance.** Median C1 scenario completes in **≤4 LLM calls**; the panel shows progress
within 2s of submit; no scenario exceeds `MAX_STEPS`.
**Files.** `agentLoop.ts`, `tools.ts`, `useAgent.ts`. **Size.** Medium.

### C7 — Honest degradation
**Goal.** No key, rate-limited, or offline should never look like a broken app.
**Approach.** Distinguish the cases (no key configured / 429 with Retry-After / network down /
map not ready) and say which, plainly, plus offer the deterministic equivalent — search, the
best-time chart (Track D), plain routing.
**Acceptance.** Each case has a C1 scenario and a distinct, non-alarming UI state; a 429 shows
the wait, not a spinner. Cancellation is reachable by keyboard, stops new model/tool work, and
cannot leave a late job able to overwrite newer state. Every status transition is exposed to
assistive technology under C15.
**Files.** `useAgent.ts`, `AssistantPanel.tsx`, `api/agent.js`. **Size.** Medium.

### C8 — Ask while walking *(stretch)*
Questions answered against the *active route* and the user's live position (needs Track B):
"is the next stretch shadowed?", "where's water on the way?".

### C10 — Untrusted content and tool authority  *(added 2026-09-07)*
**Goal.** Third-party text can never acquire tool authority. **Required before any tool returns
third-party prose — which is why it comes before C9's exit-beta criteria are meetable.**

**Where this stands today, stated accurately.** The surface is currently *narrow, not absent*.
`search_places` returns only the first two comma-segments of an OSM `display_name` plus
coordinates (`tools.ts`), and Foursquare is **not** imported by `app/lib/agent/**` at all — so
today the only third-party text reaching the model is a truncated OSM place name. This is a
**forward-looking constraint, not a live vulnerability**, and saying otherwise would be exactly
the overclaiming this track exists to prevent.

**When it becomes live.** The moment any of these land: Foursquare place details, tips or hours
reach a tool (#67); a venue's own description or reviews are surfaced; a server-side
URL-fetching tool is added; or C4's plan carries free-text from a provider.

**Approach.** Enforce permissions **in application code, not in the system prompt** — a
prompt-level instruction is a request, not a boundary. Every tool executor already validates its
arguments; extend that to treat all provider strings as data: no tool name, coordinate, time, or
destination may originate from provider text; cap and label third-party strings where they enter
the transcript; keep the write phase's tool-free system prompt (it already exists) as a second
barrier. Any future server-side fetch tool needs its own network and destination allowlist.
[Background: OWASP LLM01 — prompt injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)

**Acceptance.** C1 scenarios include adversarial place names, descriptions, image text, EXIF,
tool errors, and prior-assistant content. They assert that no tool call, waypoint, coordinate,
time, model selection, or permission originates from those values. Maintain a machine-readable
schema of trusted versus provider-controlled fields and test it at every transcript boundary.
Mutation tools independently validate user intent, argument provenance, bounds, plan version,
and idempotency. The boundary is a code path with tests and audit events, not a prompt line.
**Files.** `tools.ts`, `agentLoop.ts`, `app/lib/agent/__tests__/scenarios/`. **Size.** Medium.

### C11 — Plan revisions and repair ← **the Living Itinerary**
**Goal.** *"Actually, I'm leaving 20 minutes late"* preserves the plan and changes only what it
must. This is the second-most distinctive capability in the product after Track H's Sun Budget,
and **Track P's P3 demo recording ends on it** — no other checkpoint builds it.

**Approach.** Make the plan a **data object, not a paragraph**: origin, mode, start instant with
its IANA zone (needs **D0**), ordered stops with arrival/departure windows and dwell, selected
legs, predicted exposure, data provenance (`shadowProvenance.ts` already produces it),
uncertainties, expiration conditions, and a version id. Prefer Track E's `Trip` (E5) as the
carrier rather than a second journey model. Then a **deterministic validator** — time ordering,
budget, stop accessibility, map/plan agreement — that runs on every revision and is independent
of the model. On a change, preserve unaffected stops and re-solve only the affected span.

**Acceptance.** A C1 scenario applies a late departure to a committed plan and asserts the
result is valid, that unaffected stops kept their identity, and that the response names what
changed and what was relaxed; a second scenario does the same for a closed venue. **Report
revision minimality** — how much of the itinerary changed — alongside validity, because a
"repair" that rebuilds the whole day is a new plan wearing the old one's name.
**Files.** `app/lib/agent/**`, `app/lib/trip/**` (E5's — consume it), scenarios.
**Size.** Large. **Depends on C4, E5, D0.**
**Do not call a repaired plan "verified" beyond what was checked:** verification here means
consistency with explicit constraints and available evidence. Physical shadow accuracy is Track
A's agreement harness, and it is a separate claim.

### C12 — Visual evidence and the budget-matched baseline  *(added 2026-09-08)*
**Goal.** The agent decides **which** visual evidence to inspect, grounds every claim in a
specific image region, and is measured against baselines that got the same budget. This is the
*multimodal agent* checkpoint — the one that makes "multimodal agent implementation in a
navigation app" a sentence backed by an artifact.

**Provider correction, 2026-09-14.** This checkpoint was written while the allowlisted Cerebras
models were text-only. Umbra now uses image-capable Gemini models. `LlmPart` still lacks an image
variant, so the implementation is not multimodal today, but the old conclusion that perception
must be offline is no longer valid. C12 therefore requires a **real image-conditioned Gemini
path**. Offline extraction remains valuable as a cheaper baseline and as a deployable fallback;
it is no longer allowed to stand in for the multimodal claim.

**Approach.**
1. **Extend the neutral IR deliberately.** Add a discriminated image part carrying MIME type,
   bytes or an approved asset id, provenance, capture time, and optional crop/region. Translate it
   in `llmClient.ts`; reject unsupported formats, oversize images, remote URLs, and image parts
   for models that are not explicitly capability-allowlisted. Tests prove text-only behavior is
   unchanged and provider payloads contain the expected image data.
2. **Create a licensed, versioned evidence corpus.** Use owned or explicitly permitted,
   geotagged perspective photos across multiple routes and at least three distinct geographic
   contexts. Record capture time, coarse pose/view direction when known, license, checksum,
   source version, and limitations. Keep a held-out route/city partition that is not used while
   developing prompts or selectors. Do not use Google Street View imagery for extraction,
   training, testing, or validation.
3. **Run two perception paths.** The primary path gives selected images/crops directly to Gemini.
   The offline path stores structured observations with region, class, capture time, candidate
   edge/entrance association, and confidence or explicit `unknown`. Track A's A10 learned model
   may produce an additional observation source. Every result says which path produced it; the
   UI and report never imply Gemini saw an image when it consumed only extracted text.
4. **Expose bounded, purpose-specific tools.** `get_route_evidence` returns metadata and
   thumbnails; `inspect_view` spends one unit of an explicit image/token/latency budget and
   returns region-addressable observations. The agent must choose what to inspect next rather
   than receiving the whole corpus. Image selection is read-only; it cannot authorize routing,
   time, or destination changes.
5. **Validate separately from the model.** Check schema, asset and graph references, capture-time
   freshness, region bounds, plan-version consistency, and C5 receipt compatibility. The model
   may propose a visual observation; deterministic code decides whether it can enter a plan or
   answer.
6. **Evaluate the multimodal contribution.** Compare image-conditioned selection, offline
   observations, fixed-interval image sampling, single-pass all-images summary, metadata-only,
   and no-image behavior at equal image/token/request budgets. Repeated trials and the held-out
   split belong to C13; C12 supplies the task-specific graders.

**Acceptance.**
- A test inspects the actual provider request and proves that Gemini received image bytes, not a
  caption substituted by the harness. At least one task must require visual evidence unavailable
  in metadata or existing map tools; removing the image must measurably reduce task success.
- A scenario where the agent inspects a second view **because the first was inconclusive**, and
  the trace shows why it chose that one.
- **The baseline comparison, which is the actual deliverable:** agent-selected inspection vs.
  offline extraction vs. fixed-interval sampling vs. single-pass summary vs. metadata/no-image,
  **at equal image, token, request, and latency budgets**. Score verified-issue discovery, false
  visual claims, region association, selective-inspection efficiency, abstention quality, and
  uninspected coverage. If the selector or Gemini path loses, the result ships and the cheaper
  winner remains the default.
- Every visual assertion traces through a C5 receipt to an image id, region, model/prompt version,
  and capture time, or is reported as unknown. Unsupported or stale visual assertions fail.
- Adversarial: text inside a photographed sign is data with **no tool authority** (this is
  **C10**'s boundary — C12 is the first checkpoint that makes it live, so C10 lands first or
  with it).
- A photo shows an apparent obstacle **at capture time**. It never certifies current passage,
  an accessible route, or a lawful crossing. Wording is checked in the scenario.
- Held-out results include repeated trials and uncertainty, not one perfect pass. Latency and cost
  are reported per successful task, including image bytes and failed attempts.

**Files.** `app/lib/agent/llmClient.ts`, `app/lib/agent/tools.ts`, evidence artifacts under a
new versioned directory, scenario and held-out graders.
**Size.** Large — split: (a) IR image part, (b) corpus + offline extraction + tools, (c) the
native Gemini path and task graders, (d) equal-budget comparison. **Depends on C10 and C13's
split/version format; consumes C11's `Trip`. A10 is optional for C12 but required for the full
agent-capstone evidence bar.**

### C13 — ShadowBench: held-out, repeated, end-to-end agent evaluation
**Goal.** Turn a useful regression harness into an evaluation program that can estimate how the
agent behaves on tasks it was not tuned against.
**Approach.** Keep C1 as the fast deterministic suite. Add a separately versioned held-out set
with multiple cities, time zones, sparse and dense map contexts, feasible and infeasible goals,
ambiguous language, tool failure, stale data, and adversarial third-party content. Its answers
and grader fixtures are not available to the prompt/loop implementation. Run three layers:
(1) scripted-model regression over real loop code, (2) live-model over controlled tool snapshots,
and (3) a small rate-limited end-to-end tier using recorded/replayable real provider responses and
real domain tools. Repeat stochastic layers enough to report intervals rather than single-run
perfect scores.

Compare the current loop with deterministic/no-agent and single-pass baselines under equal
request, token, image, latency, and tool budgets. Grade final application state and C5 claims:
valid terminal plan, constraint satisfaction, place/shadow/time/route evidence, recovery,
unsupported-claim rate, revision minimality, latency distribution, tokens, requests, and cost per
successful task. Save raw traces with dataset version, code SHA, model id, prompt/tool-schema
version, temperature, seed where supported, and failure classification.
**Acceptance.** Development and held-out sets are mechanically separated and leakage-checked;
the real-tool tier catches at least one failure that stubs do not; repeated results include
sample count and intervals; every headline metric links to raw traces and includes partial,
unknown, timeout, and failure outcomes. A deliberately degraded loop/model is detected. CI runs
the deterministic tier, scheduled/manual automation runs the live tiers within a declared quota,
and regression thresholds gate C14 promotion.
**Files.** `app/lib/agent/eval/**`, fixtures/snapshots, CI/scheduled workflow, versioned reports.
**Size.** Large. **Build after C4/C5; C12 adds multimodal graders rather than a separate harness.**

### C14 — Versioned inference releases, observability, and rollback
**Goal.** Demonstrate the ML-infrastructure lifecycle appropriate to a hosted-model agent: a
tested release moves through evaluation, limited exposure, monitoring, and reversible promotion.
**Approach.** Define an immutable `AgentRelease` manifest containing model ids/capabilities,
prompt and tool-schema hashes, evaluator/dataset versions, input/output/tool budgets, retry
policy, code SHA, and fallback release. The production gateway—not a client-crafted upstream
payload—owns the allowlist, generation bounds, capability checks, and release selection. The
loop remains client-side: it sends a typed transcript/tool-result envelope plus release id, and
the gateway validates that envelope and constructs the provider request from the release. Add a
privacy-minimized durable quota across instances, cancellation, structured error classes, and
sampled audit/quality events with explicit retention. Never store raw conversation, precise
location, or images by default.

Promote a candidate only after C13 thresholds. Use preview/shadow traffic or an explicit small
canary cohort, compare task-success and failure/latency/cost distributions, then promote or roll
back by release id without a code rebuild. Monitor provider/model drift, tool-contract failures,
unsupported claims, terminal-job failures, rate limits, and budget exhaustion. The deterministic
non-agent planner is the final degradation path.
**Acceptance.** A documented rehearsal deploys a deliberately bad candidate, the evaluation or
canary detects it, and one operation restores the previous release. Cross-instance quota tests,
payload/capability rejection tests, cancellation tests, retention/deletion tests, and a provider
model-change simulation pass. Publish SLOs and an incident/postmortem template, then record at
least one synthetic incident from detection through rollback. Do not claim high scale; claim the
release, monitoring, and recovery mechanisms that were actually exercised.
**Files.** `api/agent.js` or split gateway modules, release manifests, telemetry interfaces,
deployment/eval workflows, runbooks. **Size.** Large. **Depends on C13; coordinates with G8.**

### C15 — Accessible assistant and evidence interaction
**Goal.** Make the complete plan-and-evidence workflow usable without a pointer or visual map.
Accessibility is product correctness for a navigation assistant and a preferred qualification in
both saved Google Geo descriptions.
**Approach.** Give the panel an accessible dialog name and semantics; label the composer without
placeholder dependence; move focus on open and return it on close; implement and test appropriate
focus containment; provide keyboard submit, cancel, receipt navigation, and map/list equivalents;
announce thinking, tool progress, degradation, completion, and errors through controlled live
regions without flooding the reader. C5 receipts expose their subject, status, uncertainty, age,
and relationship to plan stops in text. Visual-only region evidence has a structured textual
equivalent, while unknown information remains unknown.
**Acceptance.** Axe has zero serious/critical violations in the assistant journey. Automated
keyboard tests complete submit → progress → receipt inspection → plan revision → cancel/close and
verify focus return. Manual NVDA or VoiceOver passes the same documented script at desktop and
mobile widths; announcements are captured in the test note. At least one user or accessibility
reviewer evaluates the workflow before making a broad accessibility claim. G5 owns the shared
axe baseline; C15 owns remediation and agent-specific interaction tests.
**Files.** `AssistantPanel.tsx`, `useAgent.ts`, receipt components, component/browser tests,
accessibility test note. **Size.** Medium. **Depends on C5/C7; coordinates with G5.**

### C9 — Exit beta
Published criteria, all measured rather than felt: C1 deterministic scenarios green for three
consecutive weeks; C13 held-out and real-tool thresholds met with intervals; zero unsupported
claim escapes in deterministic tests and the held-out escape rate reported by claim type; C4
terminal outcomes and cancellation proven; C10 adversarial boundary proven; C12 image-conditioned
results and equal-budget baselines published; C14 rollback rehearsal complete; C15 accessibility
journey complete; p50/p95 latency and cost per successful task inside their declared budgets.
Until then the assistant stays labelled beta. “Exit beta” means these published product contracts
are met; it does not mean perfect answers, universal accessibility, Google-scale traffic, or
employment qualifications.

---

## Subagent plan

- **C1's scenarios are swarm-able** — each scenario is an independent fixture file. Write the
  harness solo, then fan out 3–4 builders on scenario batches in worktrees.
- **C2, C5, C6 are solo** — they change loop control flow, where interactions bite.
- **C13's split is frozen before parallel fixture work.** Builders may add cases only to their
  assigned partition; nobody developing the loop reads held-out answers or edits its grader.
- **C14 is solo at the gateway/release boundary.** Telemetry dashboards, runbook prose, and
  failure fixtures may parallelize after event and privacy schemas are fixed.
- **C12 splits only after the image IR and corpus license manifest land.** Provider translation,
  offline baseline, and graders can then proceed in disjoint files. C15 can run alongside them.
- **Scout** for provider questions ("does Gemini's free tier cap requests per key or per project?") —
  bounded and answerable from docs.
- **Verifier on C2 and C6.** Both can look correct and quietly regress grounding or blow the
  rate budget.

## Risks

1. **Building on the stale review.** Two of its three complaints are fixed. Read the code, not
   the archive. (This brief's "What's already true" is the correction; if it drifts, fix it.)
2. **The eval harness measuring prose.** Asserting on wording makes the suite brittle and
   meaningless. Assert on *behavior*: which tools ran, in what order, with what arguments.
3. **Rate-limit-shaped design failures.** A per-minute free-tier cap means an "obviously better" extra
   verification call can double turn latency. Every added call needs a C6 budget justification.
4. **Scope creep toward a general chatbot.** The system prompt is deliberately narrow
   (shadow-day-planning only). Keep it that way — breadth is where Gemini wins and we can't.
5. **Held-out leakage.** A scenario ceases to estimate generalization once its expected answer
   tunes the loop. Promote discovered failures into the next versioned development set and cut a
   new untouched holdout; never silently keep scoring the exposed item as held out.
6. **Telemetry becoming surveillance.** Precise locations, raw chats, and images are more data
   than C14 needs for service health. Default to aggregate events and short retention, test
   deletion, and require an explicit purpose before retaining content.

## Out of scope / hand-offs

- Shadow math → **Track A**. Routing → **Track E**'s pipeline. Heat/UV → **Track D**.
- Live position → **Track B** (C8 consumes it).
- Paid inference or a second LLM provider → not this project. The free Gemini models now
  allowlisted in `api/agent.js` accept images and are the C12 path. A free durable deployment
  store is permitted only for C14's quota/release evidence, with retention and deletion defined.
