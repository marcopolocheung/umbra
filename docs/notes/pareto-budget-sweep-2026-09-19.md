# A3 — paretoRoutes city-scale budget sweep — 2026-09-19

Session A3 of
[`docs/handoffs/LATENCY_ATTRIBUTION_SESSIONS.md`](../handoffs/LATENCY_ATTRIBUTION_SESSIONS.md),
branch `perf/a3-pareto-budget-curve` (PR 1 of 2). This PR **measures only** — it
commits the harness and the published curve; it changes no routing behavior.
PR 2 applies the decision rule below on top of this curve, and it is the only
place the handoff authorizes touching routing constants.

**Trigger (committed):** `paretoRoutes` 2-point on the seeded synthetic grid is
484.3 ms at 4,600 nodes and **2,434.6 ms at 16,800 nodes** — superlinear —
against a 16.8 k < 300 ms gate
([`navigation-latency-attribution-2026-09-19.md`](./navigation-latency-attribution-2026-09-19.md)).
This is the one fix that trades route diversity for speed, so it is priced
first and only then retuned.

## Environment & method

Same box and node as the Phase-0 Node rows: WSL2 marcopolo
(`6.18.33.2-microsoft-standard-WSL2`), 20 cores, 15 GiB, Node `v24.21.0`
(`~/.local/node24/bin`), running

```bash
export PATH="$HOME/.local/node24/bin:$PATH"
npx vitest bench --run app/lib/__benchmarks__/navigationScale.bench.ts
```

The sweep is the new "paretoRoutes budget sweep (A3 curve)" describe in that
file: `maxDetourFactor ∈ {1.1, 1.25, 1.5, 2.0, 2.5, 3.0}` ×
`maxLabelsPerNode ∈ {5, 10, 20}` on the committed 4,600-node (92×50) and
16,800-node (140×120) grids. Time rows are the committed scale-case pair
(opposite corners) for comparability with the trigger; route-quality rows are
the mean of four fixed O-D pairs per size (opposite corners, city diagonal,
full row, full column — the `detourSweep.bench.spec.ts` precedent of spreading
pairs so one easy pair cannot carry the average). The `bench()` rows use 5
iterations at 4,600 nodes and 3 at 16,800 nodes (the expensive rows), each
after 1 warm-up; search time is tinybench's mean. The Node bench is stable
~±3–7% at these sizes.

Route quality is priced exactly like `computeDerivedKpis`: shadow gain =
most-shadowed vs shortest `shadowCoverage` in percentage points; length
overhead = most-shadowed distance over the shortest, in percent. Mean grid
`shadowFactor` is 0.478 (guarded non-degenerate, 0.05–0.95).

## The curve

### Search time (mean, ms)

| maxDetourFactor | cap 5 | cap 10 | cap 20 |
|---|---:|---:|---:|
| 1.10 | 270.9 | 735.3 | 2,144.5 |
| 1.25 | 279.1 | 781.6 | 2,192.8 |
| 1.50 | 266.9 | 650.4 | 2,148.2 |
| **2.00 (current)** | **283.1** | **639.7** | **2,295.3** |
| 2.50 | 290.1 | 754.0 | 2,313.8 |
| 3.00 | 281.3 | 585.8 | 2,382.0 |

For the anchor, the run's own 2-point case measured 2,219.6 ms at 16,800 nodes
before the sweep — the committed 2,434.6 ms trigger, within its ±3% run
spread. A second full pass of the file reproduced the key rows within the
quoted margins (cap-5 cells 279.7/287.3/291.1/270.3; 2.0/20 2,302.7), with the
noisy tail cells 2.5×5 and 3.0×5 straddling 300 ms between passes (322.0/307.1
pass A → 290.1/281.3 pass B) — borderline, never comfortably under. The
4,600-node curve is flat in the budget: cap 5 ≈ 55–59 ms, cap 10 ≈ 140–143 ms,
cap 20 ≈ 380–407 ms (the 1.10 factor prices the only cheap cap-20 cell,
314 ms). Every 16,800-node cell under 300 ms is on the cap-5 row.

### Route quality (mean of 4 O-D pairs; gain pp, overhead %)

| maxDetourFactor | cap 5 | cap 10 | cap 20 |
|---|---|---|---|
| 1.10 | 4.60 pp / +5.0% | 8.39 pp / +10.7% | 8.64 pp / +11.9% |
| 1.25 | 4.60 pp / +5.0% | 8.83 pp / +11.1% | 12.77 pp / +20.0% |
| 1.50 | 4.60 pp / +5.0% | 8.83 pp / +11.1% | 12.85 pp / +20.9% |
| **2.00 (current)** | **4.60 pp / +5.0%** | **8.83 pp / +11.1%** | **12.85 pp / +20.9%** |
| 2.50 | 4.60 pp / +5.0% | 8.83 pp / +11.1% | 12.85 pp / +20.9% |
| 3.00 | 4.60 pp / +5.0% | 8.83 pp / +11.1% | 12.85 pp / +20.9% |

On the committed scale-case pair alone the per-cap families are 0.78 pp
(cap 5), 1.68 pp (cap 10), 3.31 pp (cap 20) — smaller in absolute terms but
the same ordering and ratio; the per-pair rows are in the harness output
(`### A3 budget sweep — route quality`).

### What the curve says

- The budget factor matters less than the label cap on this grid: time and
  quality move in cap bands, not in the detour factor (which mainly widens the
  prune); at 4,600 nodes the curve is essentially flat (and there cap 10 keeps
  10.16 of 10.70 pp — the city-scale row is the binding one).
- Current 2.0/20 costs 2,295.3 ms at 16.8 k (2,302.7 ms on the first pass);
  the only cells under the 300 ms gate sit on cap 5, and every cap-5 cell is
  one quality band below cap 10.
- The search always returns 3 routes (shortest / knee / most shadowed) at
  every point — the *diversity loss* is in coverage/detour, not in the count.

## PR 2 decision rule (from the handoff)

| step | rule |
|---|---:|
| 1 | On the ≤16.8 k curve, erase every point whose shadow-gain loss vs 2.0/20 exceeds the product expectation — **default: gain within 2 pp of current** — or whose overhead is worse. |
| 2 | Pick the **lowest cost** among the survivors. |
| 3 | If no point satisfies both, **stop and file the conflict** — never pick by guess. |

Applied to the 16,800-node curve (the gate): survivors within 2 pp of the
2.0/20 mean of 12.85 pp need ≥ 10.85 pp, which only the cap-20 band itself
reaches — every cheaper band tops out at 8.83 pp (−4.0 pp). The only cells
under the 300 ms target sit on cap 5 at a mean 4.60 pp (−8.2 pp). No point
satisfies the product expectation and the cost target together — step 3 fires
and PR 2 files the conflict instead of retuning.

## No production change in this PR

`app/lib/routing.ts` gains one optional field, `maxLabelsPerNode` (default 20)
in `DijkstraOptions`, read exactly where the previous hard-coded
`MAX_LABELS_PER_NODE = 20` sat. Production callers never pass it, so shipped
behavior is byte-identical to `main`; `routing.test.ts` is unchanged and
passes. The knob exists solely so the sweep can measure the cap dimension of
the curve this session prices; PR 2 is the only authorized place to retune
the *defaults*.

## Gates

- `npm run lint` — no new warnings vs `main`.
- `npm run typecheck` — clean (with `server/navigation-prep` deps installed).
- `npx vitest run app/lib/__tests__/routing.test.ts app/lib/__tests__/metrics.test.ts` — green.
- `npm test` — 1486 passed; only the 3 pre-existing `transit access walks`
  failures in `useNavigation.test.tsx`, verified identical on `main`.
- `npm run build` — clean; `npm run e2e` — 5/5 including the route-calculation
  and published-transit smoke.
