# A3 — paretoRoutes budget decision: no operating point — 2026-09-19

Session A3 PR 2 of
[`docs/handoffs/LATENCY_ATTRIBUTION_SESSIONS.md`](../handoffs/LATENCY_ATTRIBUTION_SESSIONS.md),
continuing `perf/a3-pareto-budget-curve` after its merge. **No routing constant
changes.** The decision rule ran against the committed curve and its step 3
fired — the conflict is filed here instead of a retune. This is the one place
the session authorizes changing routing constants, and the rule says explicitly
to never pick by guess; this note is what the rule prescribes.

The curve is in
[`pareto-budget-sweep-2026-09-19.md`](./pareto-budget-sweep-2026-09-19.md); the
decision table below is applied on the same machine/method (WSL2 marcopolo,
Node v24.21.0, tinybench means; 16,800-node rows are the gate).

## Decision rule (the handoff's, re-stated)

| step | rule |
|---|---:|
| 1 | On the ≤16.8 k curve, erase every point whose shadow-gain loss vs 2.0/20 exceeds the product expectation — **default: gain within 2 pp of current** — or whose overhead is worse. |
| 2 | Pick the **lowest cost** among the survivors. |
| 3 | If no point satisfies both, **stop and file the conflict** — never pick by guess. |

At 16,800 nodes the 2.0/20 reference is **2,295.3 ms mean search**, **+12.85 pp**
gain, **+20.9%** overhead. Step 1 keeps points whose gain ≥ 10.85 pp with overhead ≤ +20.9%;
step 2 would then pick the cheapest of that set; the acceptance additionally
demands 16.8 k < 300 ms.

## The survivors and why no point works

| operating point | mean ms | gain (pp) | Δ vs 2.0/20 | overhead | verdict |
|---|---:|---:|---:|---:|---|
| 2.0 × 20 (**current**) | 2,295.3 | 12.85 | 0.00 | +20.9% | passes step 1; 7.7× over the cost target |
| 1.5 × 20 | 2,148.2 | 12.85 | 0.00 | +20.9% | cheapest step-1 survivor; still 7.2× over target |
| 1.1 × 5 | 270.9 | 4.60 | **−8.25 pp** | +5.0% | under 300 ms, fails step 1 by 6.25 pp |
| 1.25 × 5 | 279.1 | 4.60 | −8.25 pp | +5.0% | under 300 ms, fails step 1 by 6.25 pp |
| 1.5 × 5 | 266.9 | 4.60 | −8.25 pp | +5.0% | cheapest of all; fails step 1 by 6.25 pp |
| 2.0 × 5 | 283.1 | 4.60 | −8.25 pp | +5.0% | the price the handoff sketched; fails step 1 |
| 2.5 × 5 / 3.0 × 5 | 290.1 / 281.3 | 4.60 | −8.25 pp | +5.0% | straddle 300 ms between the two passes; fail step 1 either way |
| 1.5 × 10 | 650.4 | 8.83 | **−4.02 pp** | +11.1% | overhead ok; fails step 1 by 2.02 pp and the cost target |
| any other cap-10 cell | 585.8–781.6 | 8.39–8.83 | −4.02…−4.46 pp | +10.7…+11.1% | same, on both grounds |

Reading it the other way: the cheapest point meeting the *product expectation*
(≥ 10.85 pp) is 1.5 × 20 at 2,148.2 ms, and the cheapest point meeting the
*cost target* (< 300 ms) is 1.5 × 5 at 266.9 ms / 4.60 pp. The two constraints
do not intersect anywhere on the curve. Step 3 fires.

The 4,600-node rows are not binding (the gate is city-scale), but the contrast
deserves recording: there cap 10 keeps 10.16 of 10.70 pp (−0.54 pp, within
2 pp) at ~143 ms. The conflict is a city-scale property of this grid — the
Pareto front thins under a cap that the 16.8 k search needs to go fast.

## What would flip the decision (for the product, not for this session)

The curve prices each relaxation exactly; the note records the thresholds so a
future decision can cite numbers instead of judgement:

- Accept a **gain expectation ~64% below current** (loss ≤ ~8.25 pp): the
  cap-5 band then qualifies at 266.9–290.1 ms. 2.0 × 5 is 283.1 ms.
- Accept **≥ 4.02 pp gain loss**: cap 10 qualifies — at 585.8–781.6 ms, still
  ≥ 2× the cost target. Meeting 300 ms needs the cap-5 band, i.e. the 8.25 pp
  relaxation above.
- Keep the 2 pp expectation: the curve's cheapest compliant point is
  2,148.2 ms (1.5 × 20) — the cost target itself must move.
- No combination of the two constants in the swept range meets both published
  constraints; an intersection would need an algorithmic change beyond these
  knobs (its own session, its own curve) — not a constant picked by guess.

## No production change in this PR

`app/lib/routing.ts` keeps the defaults exactly as `main` (2.0/20):
`maxDetourFactor = 2.0`, `maxLabelsPerNode = 20` (the PR 1 knob is untouched,
default intact). `routing.test.ts` is unchanged. Browser routing output is
byte-identical — the 2-pt bench scenarios are unaffected by construction.

## Gates

- `npm run lint` — 59 warnings / 8 infos, identical to `main`; no warnings in
  touched files (this PR touches docs only).
- `npm run typecheck` — clean with `server/navigation-prep` deps installed.
- `npx vitest run app/lib/__tests__/routing.test.ts app/lib/__tests__/metrics.test.ts` — 126 passed.
- `npm test` — 1486 passed; only the 3 pre-existing `transit access walks`
  failures in `useNavigation.test.tsx` (identical on `main`).
- `npm run build` — clean; `npm run e2e` — 5/5.
- One `npm run bench:route` pass: 2-pt cold p50 1038.2 ms, 2-pt warm p50
  43.6 ms — unchanged within the historic noise of the A2 numbers (995.9 /
  48.6), as it must be: no routing change exists to move them. Browser route
  output is byte-identical to `main`.
