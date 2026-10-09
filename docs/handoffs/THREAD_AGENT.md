# Handoff — the agent thread: C2 → C3 → C4 → C5 → C10 → C11 → C12

**Mission.** Build the multimodal agent. This is the thread that answers *"multimodal agent
implementation in a navigation app"* with an artifact rather than a claim.

**Verified 2026-09-08 at `99bb418`.** Brief: `docs/tracks/TRACK_C.md`.

> **Runs in parallel with the shadow thread.** Track C owns `app/lib/agent/**` outright and
> reaches the rest of the app only through tool wrappers — it is the friendliest track to run
> alongside any other. The two threads do not collide.

---

## Where the hirability actually is

Not in the segmenter. Fine-tuning a small model on street images is a well-trodden exercise many
candidates have. **This thread is the differentiated one**, and it is weeks rather than months:

1. **Active perception under budget** (C12) — the agent chooses *which* views to inspect next,
   scored against fixed-interval sampling and single-pass summary **at equal image and token
   budgets**. Almost nobody builds the baseline. That comparison is the interview.
2. **Typed visual assertions** (C12) — region, image id, capture time, edge/entrance
   association, confidence **or an explicit unknown**. Grounding as a data structure, not a
   prompt instruction.
3. **A deterministic validator separate from the model** (C11/C12) — the model proposes, the
   validator decides.
4. **Persistent state repair** (C11 + E5) — versioned `Trip`, expected-version check,
   idempotency key, revision preserving unaffected stops.
5. **Untrusted content** (C10) — text in a photographed sign is data with **no tool authority**.

**C11 is the second-most distinctive capability in the product after Track H, and P3's demo
recording ends on it.**

---

## The two provider facts that shape everything · **read before designing anything**

Verified at `f61371c`, still true at `99bb418`:

```
llmClient.ts:25   LlmPart { text?, functionCall?, functionResponse? }   ← no image part
api/agent.js:36   DEFAULT_ALLOWED_MODELS = ["gpt-oss-120b", "zai-glm-4.7"]  ← both text-only
```

**There is no vision model on the free provider, and adding one that has it is a `ROADMAP.md` §2
anti-goal** that breaks the free-tier guardrail.

**So perception runs offline and the agent selects among its outputs.** That is not a
consolation prize — it is `ROADMAP.md` §6's Tier 1, and it is the same shape as Google's IRL
routing work: expensive inference offline, stored, fast online search over the result.

**Say so plainly. Never imply the model looked at a photograph when it read a precomputed
observation.** A sharp interviewer will ask whether your agent really sees; the answer that
survives is *"the loop is multimodal-capable, perception is offline because the provider is
text-only and because precomputing is the right architecture anyway, and the local-VLM path is
measured separately against it."* The weak version is pretending.

---

## The order

| # | Checkpoint | Note |
|---|---|---|
| **C2** | Ground the write phase | The active checkpoint. Use C1's harness to find where plot-before-answer leaks — candidates collected but not plotted, places named in prose that never became candidates, the `separateWrite === false` path. Close **#59** by observation in `npm run dev`. |
| **C3** | Probes on the `ShadowField` | **Needs A2/A6 — stub until the shadow thread lands A6.** Do not block on it; stub and move on. |
| **C4** | The plan job contract | **Re-scoped 2026-09-07 — read the brief.** Multi-stop already shipped (`tools.ts:448` accepts `via`); the missing piece is that `plan_shadowed_route` returns `{ok:true, note:"…started"}` and never awaits a terminal result. Reuse the existing generation counters and cancellation in `useNavigation.ts:979` — **do not rebuild them.** |
| **C5** | Answers with receipts | |
| **C10** | Untrusted content and tool authority | **Gates C12** — C12 is the first checkpoint that makes this surface live. Land it first or with it. |
| **C11** | Plan revisions and repair | The Living Itinerary. **Depends on C4, E5, D0.** Report **revision minimality** alongside validity — a "repair" that rebuilds the whole day is a new plan wearing the old one's name. |
| **C12** | Visual evidence + the budget-matched baseline | The multimodal checkpoint. Split: (a) IR image part, (b) corpus + offline extraction + tools, (c) the baseline comparison. |

---

## C12's corpus is deliberately cheap · **do not let it acquire Wave 4's costs**

Geotagged perspective photos along one route. **No pose precision, no seasonal repeats, no
reviewed masks.** An afternoon of shooting is the intended budget.

**C12 does not depend on Wave 4 Option A.** The research PDF ranks the perception feature first
and calls Features 1–3 an "integrated capstone", which reads as a prerequisite chain from
perception to the visual agent. **It is not one.** The visual agent needs *images with
locations*; it does not need a trained segmenter, calibrated pose, seasonal repeats, or
masks-as-labels.

**If the selector does not beat fixed-interval sampling at equal budget, that result ships.** It
is a finding, not a failure, and P4 has a row for it.

---

## Traps

- **The eval harness measuring prose.** Assert on *behaviour* — which tools ran, in what order,
  with what arguments. C1's assertions read a `Trace`, never the answer's wording. Keep it.
- **Rate-limit-shaped design failures.** Cerebras is **5 req/min**. An "obviously better" extra
  verification call can double turn latency. Every added call needs a C6 budget justification.
- **Scope creep toward a general chatbot.** The system prompt is deliberately narrow
  (shadow-day-planning only). Breadth is where Gemini wins and we cannot.
- **Building on the stale review.** The 2026-07-05 project review (git history) is partly stale — read the
  brief's "What's already true" section, and the code, not the archive.
- **A photo shows an apparent obstacle at capture time.** It never certifies current passage, an
  accessible route, or a lawful crossing. Wording is checked in the scenario.

## Note on the brief's state block

`TRACK_C.md` still says *"C1 landed as PR #191"* with #191 open — it merged on 2026-09-08.
Refresh the `## Current state` block in your first PR. **The code wins.**

## Done when

`/gates` green per PR, `/checkpoint` before review, brief state block updated in the same PR.
The `grounding-auditor` agent is worth running on anything touching `app/lib/agent/**`.
