# A4b: borough holdout, clean ablation, temperature (2026-10-15)

Plan A's second evaluation step ([handoff § Evaluation (A4)](../handoffs/SHADE_SIGNATURES.md#evaluation-a4--the-interview-artifact)),
following [A4a](shade-spots-eval-2026-10-14.md). Same harness, same live shade data (generation
`nyc-2026-09-18-ab747d9b8627` through the production delivery Worker), same models
(`gemini-3.5-flash-lite` research, `gemini-3.1-flash-lite` write), three repeats. New since A4a:

- **Five holdout scenarios** outside Manhattan (#360), each mirroring a Manhattan decision. The
  tool description was tuned on the Manhattan set only and was not changed after these ran.
- **A clean ablation:** `AGENT_EVAL_ABLATE` now also strips the withheld tool from both system
  prompts, and throws if a mention survives.
- **`AGENT_EVAL_TEMPERATURE`**, for the 0 vs 1.0 comparison.
- The #354 route fixes (#356, #357, #359) are in all three arms.

The three main arms ran on `main` at `efa3f67`, before #362 and #363. A fourth run, after #362,
re-checks the holdout and is reported separately.

```bash
S=$(cat ids.txt)   # the 11 A4a shade ids + the 5 holdout-* ids
AGENT_EVAL_ONLY=$S AGENT_EVAL_REPEATS=3 AGENT_EVAL_OUT=/tmp/with-tool npm run eval:agent
AGENT_EVAL_ONLY=$S AGENT_EVAL_REPEATS=3 AGENT_EVAL_ABLATE=find_shade_spots AGENT_EVAL_OUT=/tmp/ablated npm run eval:agent
AGENT_EVAL_ONLY=$S AGENT_EVAL_REPEATS=3 AGENT_EVAL_TEMPERATURE=1 AGENT_EVAL_OUT=/tmp/temp1 npm run eval:agent
```

**Superseded run.** The first ablated run (2026-10-15 20:53) is void: `gemini-3.1-flash-lite`
returned HTTP 503 "high demand" on 297 requests and 35 of 48 runs errored before any model turn.
The rerun below had no errored runs (2 transient 503s, retried).

## Headline

48 runs per arm. No arm had a data failure or a grounding violation.

| | with the tool | tool withheld (clean) | temperature 1.0 |
|---|---:|---:|---:|
| **Task success** | **91.7%** | **33.3%** | 87.5% |
| pass^1 (task + expected tool) | 91.7% | 25.0% | 87.5% |
| **pass^3**, all 16 scenarios | **87.5%** (14/16) | **25.0%** (4/16) | 81.3% (13/16) |
| pass^3, Manhattan (11, tuned) | 90.9% | 27.3% | 90.9% |
| pass^3, holdout (5, untuned) | 80.0% | 20.0% | 60.0% |
| Median LLM calls per run | 4 | 7 | 5 |
| Median conversation | 9.1 s | 13.9 s | 9.9 s |
| Invalid-parameter rate | 15.6% | 52.3% | 22.0% |
| `shade_window` claims verified | 104/105 | 0/2 | 91/94 |
| Requests | 206 | 308 | 220 |

## The clean ablation

Without the tool, every shade scenario fails: the model reaches for `set_time` (27 of 36 shade runs)
or `search_places` (9), and neither can answer a time-window question. It called the withheld
tool **0 times**; A4a's leaky ablation, which left the tool named in the prompt, called it in 7
runs. So this arm measures the model without the tool, not the model working around a missing
declaration.

| | A4a, leaky ablation (11 scenarios) | A4b, clean ablation (11 Manhattan) |
|---|---:|---:|
| pass^3 with the tool | 90.9% | 90.9% |
| pass^3 withheld | 18.2% | 27.3% |

The tool is worth about 63–73 points of pass^3 on the Manhattan set either way. The clean
number is the one to quote. The three scenarios that pass withheld are the ones that should never
call the tool (`right-now-uses-check-shadow`, `pure-lookup-no-shade-search`, `off-topic-no-tools`)
plus the Brooklyn "right now" twin. `shade-another-date` counts as answered 3/3 withheld because
`set_time` produced a verified time, but it is not the answer asked for, so pass is 0/3.

## The borough holdout

With the tool, four of five holdout scenarios pass 3/3; `holdout-bronx-sunset` fails 3/3 with no
tool executed. A diagnostic replay traced it:

1. The model calls `find_shade_spots` with Fordham Plaza coordinates from its own memory. The
   authority correctly refuses: they are not an application candidate.
2. It geocodes **"Fordham Plaza, Bronx"**, refused as `missing_current_user_intent`: the
   query-term check accepted only words the user typed and new/york/nyc, and the user never
   typed "Bronx".
3. `search_places` near "Fordham Plaza, Bronx" is refused for the same reason.

Brooklyn hit the same refusal and retried without the borough; the Manhattan set never showed it
because the model never appends "Manhattan". This was filed as #361 and fixed in **#362**
(borough and city qualifiers are now application terms).

**After #362** (holdout only, `main` at `8a9b8b7`, 66 requests): **5/5 pass^3, 15/15 runs,
48/48 `shade_window` claims verified**, `holdout-bronx-sunset` 3/3. This run is a before/after
check, not a fresh holdout: the scenarios that found the gap can't also certify its fix. A new
held-out set would be needed for that.

## Temperature 0 vs 1.0

| scenario | temperature 0 | temperature 1.0 |
|---|---:|---:|
| sun-mode-search | 3/3 | 1/3 |
| holdout-queens-date | 3/3 | 1/3 |
| holdout-bronx-sunset | 0/3 | 1/3 |
| shade-near-map-centre | 2/3 | 3/3 |
| every other scenario | 3/3 | 3/3 |

At 1.0, pass^3 is 81.3% against 87.5% at 0, the invalid-parameter rate rises from 15.6% to 22.0%,
and 3 `shade_window` claims are rejected against 1. The Manhattan pass^3 ties at 90.9%; all of
the loss is on the holdout. The rule was to change the default only if 1.0 is no worse.
**Decision: keep temperature 0.** The gap is one scenario out of 16, so the evidence says "not
better", not "clearly worse"; Google's warning that low temperature may loop did not show up
(no run hit the step cap at 0).

## Per scenario

Task / pass, three runs each.

| scenario | with the tool | withheld | temperature 1.0 |
|---|---:|---:|---:|
| shade-window-today | 3/3 · 3/3 | 0/3 · 0/3 | 3/3 · 3/3 |
| shade-another-date | 3/3 · 3/3 | 3/3 · 0/3 | 3/3 · 3/3 |
| sun-mode-search | 3/3 · 3/3 | 0/3 · 0/3 | 1/3 · 1/3 |
| shade-near-map-centre | 2/3 · 2/3 | 0/3 · 0/3 | 3/3 · 3/3 |
| shade-like-this-one | 3/3 · 3/3 | 0/3 · 0/3 | 3/3 · 3/3 |
| shade-crosses-sunset | 3/3 · 3/3 | 0/3 · 0/3 | 3/3 · 3/3 |
| right-now-uses-check-shadow | 3/3 · 3/3 | 3/3 · 3/3 | 3/3 · 3/3 |
| outside-coverage-says-so | 3/3 · 3/3 | 0/3 · 0/3 | 3/3 · 3/3 |
| pure-lookup-no-shade-search | 3/3 · 3/3 | 3/3 · 3/3 | 3/3 · 3/3 |
| off-topic-no-tools | 3/3 · 3/3 | 3/3 · 3/3 | 3/3 · 3/3 |
| find-then-route-there | 3/3 · 3/3 | 1/3 · 0/3 | 3/3 · 3/3 |
| holdout-brooklyn-window | 3/3 · 3/3 | 0/3 · 0/3 | 3/3 · 3/3 |
| holdout-queens-date | 3/3 · 3/3 | 0/3 · 0/3 | 1/3 · 1/3 |
| holdout-queens-sun | 3/3 · 3/3 | 0/3 · 0/3 | 3/3 · 3/3 |
| holdout-bronx-sunset | 0/3 · 0/3 | 0/3 · 0/3 | 1/3 · 1/3 |
| holdout-brooklyn-right-now | 3/3 · 3/3 | 3/3 · 3/3 | 3/3 · 3/3 |

`find-then-route-there` is 3/3 at exactly 7 LLM calls with the tool (A4a: 2/3), after the #354
fixes. `shade-near-map-centre#2` is the one Manhattan failure: its search returned
`invalid_query`, which is the one rejected `shade_window` claim.

Tool selection with the tool: 48/48 on the diagonal (`find_shade_spots` 36, `check_shadow` 6,
`geocode_place` 3, none 3). The same holds at temperature 1.0.

## Limits

- **The eval stubs geocoding and place search.** The live arms read the real shade table but
  resolve places from a fixed gazetteer, so they can't measure search quality, geocoder
  ambiguity (bare "Grand Army Plaza" resolves to Manhattan's, not Brooklyn's), or #363's
  Foursquare merge. Measuring those needs a real-search eval mode.
- **Three repeats, 16 scenarios.** One scenario is 6.25 points of pass^3; the temperature gap is
  exactly that.
- **One model pair, one day.** A provider outage voided a run the same day; free-tier
  availability is part of what these numbers depend on.
