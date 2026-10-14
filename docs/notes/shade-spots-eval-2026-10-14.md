# A4a: does `find_shade_spots` earn its place? (2026-10-14)

Plan A's evaluation step ([handoff § Evaluation (A4)](../handoffs/SHADE_SIGNATURES.md#evaluation-a4--the-interview-artifact)).
The live runs replay the 11 shade scenarios in `app/lib/agent/__tests__/scenarios/shade.ts`
against the real model, three times each. The shade tool is not stubbed: it runs the app's
`findShadeSpots` / `findSimilarShadeSpots` against the production delivery Worker, generation
`nyc-2026-09-18-ab747d9b8627`. Models: `gemini-3.5-flash-lite` (research) and
`gemini-3.1-flash-lite` (write), temperature 0. A run that hits a shade-data failure
(`load_failed` / `not_configured`) is flagged invalid rather than scored; neither run below had one.

```bash
S=shade-window-today,shade-another-date,sun-mode-search,shade-near-map-centre,shade-like-this-one,shade-crosses-sunset,right-now-uses-check-shadow,outside-coverage-says-so,pure-lookup-no-shade-search,off-topic-no-tools,find-then-route-there
AGENT_EVAL_ONLY=$S AGENT_EVAL_REPEATS=3 AGENT_EVAL_OUT=/tmp/with-tool npm run eval:agent
AGENT_EVAL_ONLY=$S AGENT_EVAL_REPEATS=3 AGENT_EVAL_ABLATE=find_shade_spots AGENT_EVAL_OUT=/tmp/ablated npm run eval:agent
```

**Superseded runs.** The first runs on 2026-10-13 are void: the eval's fetch stub blocked the
delivery Worker, so every shade call returned `load_failed` and the pass rates measured only
tool choice. Fixed in this PR; the numbers below are from 2026-10-14.

## Headline

| | with the tool | tool withheld |
|---|---:|---:|
| **Task success** (verified answer, right unavailable notice, or correct refusal) | **97.0%** (32/33 runs) | **30.3%** (10/33) |
| pass^1 (task + expected tool) | 97.0% | 18.2% |
| **pass^3** (all three repeats pass) | **90.9%** (10/11 scenarios) | **18.2%** (2/11) |
| Median LLM calls per run | 3 | 7 |
| Median conversation | 11.8 s | 24.8 s |
| Invalid-parameter rate (refused or `invalid_query` calls) | 7.1% | 42.3% |
| `shade_window` claims verified / rejected | 74 / 0 | — |
| Grounding violations | 0 | 0 |
| Requests · Gemini 503s | 140 · 3 | 216 · 10 |

Removing the tool costs 67 points of task success and roughly doubles calls and time. Without it
the model falls back to `search_places` (14 of 24 shade runs) or `set_time` (3), neither of which
can answer a time-window question, so it ends with no verified answer. The ablated latency is
inflated by its 10 provider 503s (one run took 138 s); the call count is the cleaner comparison.

## Tool selection (with the tool)

Rows are the expected tool, columns the first substantive tool the model proposed.

| expected \ actual | check_shadow | find_shade_spots | geocode_place | none |
|---|---:|---:|---:|---:|
| check_shadow | 3 | 0 | 0 | 0 |
| find_shade_spots | 0 | 24 | 0 | 0 |
| geocode_place | 0 | 0 | 3 | 0 |
| none | 0 | 0 | 0 | 3 |

33/33 on the diagonal: "is it shaded right now" stays on `check_shadow`, a pure lookup never
searches shade, and off-topic calls no tool. Boston correctly reaches `outside_coverage` 3/3.

## Per scenario

| scenario | with: task / pass | withheld: task / pass |
|---|---:|---:|
| shade-window-today | 3/3 · 3/3 | 0/3 · 0/3 |
| shade-another-date | 3/3 · 3/3 | 0/3 · 0/3 |
| sun-mode-search | 3/3 · 3/3 | 1/3 · 0/3 |
| shade-near-map-centre | 3/3 · 3/3 | 0/3 · 0/3 |
| shade-like-this-one | 3/3 · 3/3 | 0/3 · 0/3 |
| shade-crosses-sunset | 3/3 · 3/3 | 0/3 · 0/3 |
| right-now-uses-check-shadow | 3/3 · 3/3 | 3/3 · 3/3 |
| outside-coverage-says-so | 3/3 · 3/3 | 0/3 · 0/3 |
| pure-lookup-no-shade-search | 3/3 · 3/3 | 3/3 · 0/3 |
| off-topic-no-tools | 3/3 · 3/3 | 3/3 · 3/3 |
| find-then-route-there | 2/3 · 2/3 | 0/3 · 0/3 |

**The one failure with the tool** (`find-then-route-there#2`): the model found and plotted four
sidewalks, then on "route me from Union Square to the first one" proposed five calls the
application refused and never reached `plan_shadowed_route`. The answer blamed "the route
pipeline returned an invalid terminal result", which is wrong: the refusal happened before the
pipeline. That message comes from the loop wrapping an authority refusal as a malformed terminal
result, and it exists on `main` too; filed separately.

**The ablation is not perfectly clean.** Withholding the declaration leaves the system prompt
naming `find_shade_spots`, so in 7 ablated runs (all three of each multi-turn scenario, one other)
the model called it anyway. Those calls produced no `shade_window` evidence, so
they gave the ablated arm no help; they did cost it steps. Withholding the tool also flipped
`pure-lookup-no-shade-search` to `check_shadow` first (answered, but the wrong tool).

## Product baseline: tool vs nearest sidewalk

`server/navigation-prep/tools/benchmark_shade_baseline.ts`, 200 seeded random (origin, month,
window) queries inside published support (454 attempts; seed 20261013), offline over the local
generation. It compares the tool's top result with the nearest eligible sidewalk side. Rerun from
the committed script on 2026-10-14; the summary was identical.

| | median | p90 |
|---|---:|---:|
| Mean shade over the window, tool's top result | 1.00 | — |
| Mean shade, nearest sidewalk | 0.24 | — |
| Shade gained (fraction of the window) | 0.60 | 0.99 |
| Extra metres walked | 126 m | 325 m |
| Shade gained per extra 100 m | 0.40 | 2.46 |

The top result is the nearest side in only 3.5% of queries. Typically a detour of under two minutes
buys 60 percentage points more of the window in shade.

## Not measured yet (A4b)

- **Borough holdout.** Every scenario is in Midtown or at Union Square (Boston is the only
  out-of-coverage case), so these numbers say nothing about the other boroughs yet.
- **Temperature 0 vs 1.0.**
- **A clean ablation** that also removes the tool from the system prompt.
- Repeats are three; with 11 scenarios a 90.9% pass^3 is one scenario failing once.
