# Latency Attribution — Fix Sessions

Session-by-session execution plan for the Phase-0 findings in
[`docs/notes/navigation-latency-attribution-2026-09-19.md`](../notes/navigation-latency-attribution-2026-09-19.md).
That note is the source of truth for the measurements; this document is the
source of truth for **who does what next, in what order, with what acceptance**.

Worktop-down:

- **Session A1** — 5-pt per-leg progress/preview churn (4.5 s → ms).
- **Session A2** — shadow-field readiness off the route path (0.4–2.9 s → ms).
- **Session A3** — `paretoRoutes` city-scale budget sweep (2.4 s → <300 ms, priced as a trade-off).
- **Session A4** — instrument the real static street/building path (unlocks the cloud-migration decision).
- **Magazine (B1–B4)** — measured wins deliberately not scheduled.

**Ordering rule:** A1 then A2 — both edit `app/hooks/useRouting.ts`. A3 and A4
are independent and may run in parallel in their own worktrees; rebase onto the
latest `origin/main` before opening the PR. Nobody starts a fix without the
"before" columns already committed for it — the Phase-0 note has them.

**Win condition (all sessions serve this):** warm, 5 consecutive route
calculations, p50 **< 1,000 ms** per run on the keyless NYC-scale fixtures,
plus one manual cross-check on the deployed NYC build (A4).

---

## Session 0 — mandatory setup for EVERY session

**Always work in a separate git worktree. Never edit the `~/ShadeMapNavigation`
checkout, and never touch `.worktrees/`.** CI currently fails to start on
GitHub Actions (account billing — jobs are skipped, not red), so the agent
runs the local equivalents of every CI gate and may merge a PR only after
they pass.

```bash
cd ~/ShadeMapNavigation
git status                                   # must be clean first; nothing half-done on main
git fetch origin --prune
git pull --ff-only

# <worktree> is e.g. ShadeMapNavigation-a1, branch is session-specific.
git worktree add -b <branch-name> ~/<worktree> origin/main
cd ~/<worktree>
npm ci --no-audit --no-fund
npm --prefix server/shadow-prep ci --no-audit --no-fund
npm --prefix server/transit-prep ci --no-audit --no-fund
export PATH="$HOME/.local/node24/bin:$PATH"                       # Node v24.21.0
```

Local gate set (run before every push and again after the last fix commit):

```bash
npm run lint                              # pre-existing warnings are fine; introduce none
npm run typecheck
npx vitest run app/lib/__tests__/routing.test.ts app/lib/__tests__/metrics.test.ts
npm test                                  # full vitest suite
npm run build
npm run e2e                               # smoke incl. the published-transit test
```

Benchmark protocol (used for every acceptance number — **bench specs never run
in CI, by design**):

```bash
export PATH="$HOME/.local/node24/bin:$PATH"
npm run bench:route                        # 3 consecutive full passes; save logs
npx vitest bench --run app/lib/__benchmarks__/navigationScale.bench.ts   # A3 evidence
```

Rules that never change:

1. Report the **median of the three p50s** plus the printed p95/spread. Any
   scenario whose cross-pass p50 spread exceeds 40% gets a fourth pass quoted
   next to it. Never a single-pass claim.
2. No routing constants or behaviors change **except** where a session's
   acceptance explicitly authorizes it (A3 PR 2).
3. Committed numbers go into a dated note
   `docs/notes/<session>-2026-<mm>-<dd>.md` in the
   [`performance-baseline.md`](../notes/performance-baseline.md) style
   (machine, Node, commit, table, SwiftShader caveat). The PR body carries the
   same table.
4. One branch per session (A3 and A2 may split into two PRs each as specified
   below; the second branch/PR continues from the first, rebased on `main`
   after the first merges).

Landing a PR:

```bash
git push -u origin <branch-name>
gh pr create --base main --head <branch-name> \
  --title "..." --body-file body.md
# Run every local gate above, then:
gh pr merge <number> --merge --admin       # CI is billing-blocked; local gates are the gate
cd ~/ShadeMapNavigation && git pull --ff-only
```

PR title scope: `perf(navigation): ...` for A1/A3, `feat(navigation): ...` for
A2/A4. Bodies must carry: the measured trigger, the change, the acceptance
table (before/after on ONE machine), and the dated-note link.

---

## Session A1 — strip 5-pt per-leg progress/preview work

**Trigger (committed):** 5-pt warm `dijkstra`/leg span 4,485.1 ms while the
Node 12-pass loop on the same 121-node graph costs 0.48 ms. The gap is UI
churn, not search.

**Branch:** `fix/a1-5pt-leg-progress-churn`, worktree `~/ShadeMapNavigation-a1`.
**PRs:** one.

**Expected impact:** 5-pt warm `dijkstra` collapse toward the search cost.
**Target:** median `dijkstra`/leg span on 5-pt warm **< 200 ms** (from
4,485 ms) after three passes; `walkPareto` (its search-only slice) must come
down with it.

**What to change** — `app/hooks/useRouting.ts`, the
`MULTI_LABELS`/`STRENGTHS` per-segment branch (~line 800–930):

1. Move `updateProgress({ message: "Calculating route legs", current, total })`
   from **once per leg** to **once per strength pass** (3 updates instead of
   12), reporting `si + 1` of `STRENGTHS.length` (or leg-major progress —
   decide and keep one semantic).
2. Remove the **per-leg** `await yieldToBrowser()`; keep **at most one per
   strength pass**. Verify interactively that the button→result UI still
   paints each pass; if the map visibly freezes between passes on this box,
   keep the per-pass yield and say so in the PR.
3. Keep the **per-leg `updatePreview` exactly as is** — it already only runs
   on `si === 0`; changing what the preview shows is a UX review, not this
   session.
4. **Do not touch:** abortion/cancellation (`calcGenRef`, `calcSignal`,
   `cancelled()`), route assembly (`connectRouteEndpoints`, legs, provenance,
   `recordRoutingRun`), or any search constant. Routing output must be
   byte-identical; `app/lib/__tests__/routing.test.ts` proves `routing.ts`
   untouched and the smoke e2e proves the flow.

**Why this is safe:** the 12 `dijkstra` calls are the production behavior and
stay; only their surrounding per-leg bookkeeping changes. The Phase-0 numbers
say 99.99% of the span is that bookkeeping.

**Acceptance:**
- Local gates pass.
- `npm run bench:route` × 3: 5-pt warm `dijkstra` median **< 200 ms**;
  5-pt warm total drops ~4.4 s; 2-pt scenarios unchanged within noise.
- Dated note: before/after table + the three-pass reproducibility section +
  the per-run sequences (prove no new climb).

---

## Session A2 — shadow-field readiness off the route path

**Trigger (committed):** `fieldReady` 915.0 ms NYC-scale cold / 2,852.0 ms
5-pt warm / 434.3 ms 2-pt warm, with a bimodal cheap side (~340–560 ms) and
~920 ms other side. The wait is `field.ready(shadowBbox)` +
`field.readyEdges(edgeRefs)` awaited inside the route's `tFetch` span under
`ROUTE_READINESS_BUDGET_MS` (2.5 s).

**Branch:** `feat/a2-field-ready-off-path`, worktree
`~/ShadeMapNavigation-a2`. **PRs:** two if review size demands; otherwise one.

**Expected impact:** the field's materialization leaves the calculate path.
**Targets:** warm `fieldReady` medians **< 200 ms** (2-pt warm total roughly
trending under 250 ms); **no run in a warm scenario over 600 ms** (the gate);
the 920/400 ms bimodality gone from the per-run sequences. Cold runs may
still wait — the prewarm moves the cost to page load, which is the point —
so state cold separately and require the page-load cost stays inside the
expired readiness budget (no first-paint regression in smoke).

**What to change:**

- PR 1 (core): hoist readiness.
  1. **Prewarm per generation at page load.** After the map/shadow field
     settles, trigger the same broad readiness covering the initial viewport
     (or the map camera bbox) so the first route calculation finds it cached.
     Wire it in the shadow-field owner hook (`useShadowTime` /
     `LocalShadowAdapter` area — find where `shadowFieldRef` is created),
     **not** inside `useRouting`.
  2. **Readiness cache inside the field.** Cache resolved readiness keyed by
     generation + the exact bbox/cell keys, with the same lifetime rule the
     field already uses for other caches. Re-using `field.ready(shadowBbox)`
     and `field.readyEdges(edgeRefs)` must return cached answers; the route
     still calls them every calculation (the `fieldReady` metric keeps
     measuring the tail — that is the experiment's ruler).
  3. Keep `ROUTE_READINESS_BUDGET_MS`, `readyOptions.deadlineAt`, and abort
     wiring exactly as-is. A route that somehow misses the cache still
     behaves like today — strict improvement, no new failure mode.

- PR 2 (shrink, only after PR 1 lands): narrower readiness area.
  4. The broad `shadowBbox` currently covers every node the graph fetch can
     return; once `edgeBatch` exists, request readiness for the **actual
     edge keys/cells** first and fall back to the broad box only when the
     field cannot speak for a subset. Acceptance is PR 1's table with this
     PR: the remaining non-cached tail shrinks further. Split here precisely
     so the cache win and the shrink win stay separately attributable.

**Constraints:** shadow behavior byte-identical —
`app/lib/shadowField/**` agreement suites, `memoryLedger.test.ts`, and the
canvas/pixel smoke assertions must stay green. The date/`coverage(...)`
handshake must not change. Watch memory: a viewport cache may pin less than
the per-route bbox on long routes — say so in the note.

**Acceptance:** local gates + 3-pass bench with the targets above; note the
page-load prewarm cost in cold totals and in the smoke duration; PR body
shows the bimodality histogram before/after.

---

## Session A3 — `paretoRoutes` city-scale budget curve

**Trigger (committed):** 2,434.6 ms at 16.8 k nodes (484.3 ms at 4.6 k —
superlinear). This is the one fix that trades route diversity for speed, so it
is two PRs: measure, then decide.

**Branch/per PR:**
- `perf/a3-pareto-budget-curve`, worktree `~/ShadeMapNavigation-a3` — PR 1:
  harness + published curve + note (measures and commits; changes nothing in
  routing).
- PR 2 (same session continuation, new branch off `main` after PR 1 merges):
  the chosen operating point in `app/lib/routing.ts`
  (`maxDetourFactor` default and/or `MAX_LABELS_PER_NODE`), with the curve
  table in the body. **This is the only session authorized to change routing
  constants**, and only to values the curve explicitly prices.

**PR 1 tasks:**
1. Extend `app/lib/__benchmarks__/navigationScale.bench.ts` with a sweep case:
   `maxDetourFactor ∈ {1.1, 1.25, 1.5, 2.0, 2.5, 3.0}` ×
   `MAX_LABELS_PER_NODE ∈ {5, 10, 20}` at 4,600 and 16,800 nodes, reporting
   mean search time **and** the shadow-gain / length-overhead pair
   `computeDerivedKpis` style over the returned routes (shortest vs most
   shadowed) — the synthetic grid's `shadowFactor` pattern already makes that
   meaningful, and the e2e `detourSweep.bench.spec.ts` is the precedent for
   reading gain curves.
2. Run it (Node bench is stable ±3% at these sizes) and commit the curve to
   `docs/notes/pareto-budget-sweep-<date>.md`. No production change in PR 1.

**PR 2 decision rule** (put this table in the note): pick the lowest cost on
the ≤16.8 k curve whose shadow-gain loss vs `2.0/20` stays inside the product
expectation (**default: gain within 2 pp of current, overhead no worse**); if
no point satisfies both, stop and file the conflict as a note — never pick by
guess.

**PR 2 acceptance:**
- 16.8 k case **< 300 ms** (target materially lower per curve; 2.0×5 etc).
- `routing.test.ts` unchanged where it doesn't pin the swept constant; any
  test that does get updated only with the curve numbers cited in the commit
  message. Full vitest + smoke still green.
- Three-pass `bench:route`: 2-pt scenarios show the change only if expected;
  record regardless.

---

## Session A4 — instrument the real static street/building path

**Status (committed):** `navSnapshot`+`staticStreets` measured 0.0 + 12.6 ms
— but that is the **stubbed-Overpass homologue**; the bench never sets
`VITE_NAVIGATION_BASE`, so the real cloud-storage fetch + digest + adapter
build is unmeasured on both sides (Overpass API vs R2). This session turns
that into a number; the fix it may gate is pre-baked.

**Branch:** `perf/a4-static-nav-bench`, worktree `~/ShadeMapNavigation-a4`.
**PRs:** one (bench + measurement note). Can run in parallel with A1/A3.

**Tasks:**
1. **Synthetic static street/building shard stubs** in `e2e/fixtures/`
   (pattern: `transitShards.ts` + `buildTransitShardFixture`, digest-verified)
   shaped to `app/lib/navigationData/shardContract.ts` — pointer → manifest →
   street shard(s) + building shard(s), seeded, pinned by a fixture test like
   `transitShardFixture.test.ts`. Street shard should approximate the NYC
   selection (a 10–20 k-node grid slice; watch `MAX_STREET_SHARD_BYTES` and
   slice if needed).
2. **`stubNetwork` extension** in `e2e/helpers/scenario.ts`: an explicit
   `navigation: "off" | "scale"` option beside the existing `transit` knob;
   serve the navigation origin when on.
3. **`playwright.bench.config.ts` webServer env:** add
   `VITE_NAVIGATION_BASE` pointing at the stubbed origin (mirroring
   `VITE_TRANSIT_BASE`). Add **new scenarios** — `nav-static 2-pt cold`,
   `nav-static 2-pt warm`, `nav-static NYC-scale` — leaving the existing
   scenario set untouched so the committed Overpass-homologue columns stay
   comparable.
4. Run the 3-pass protocol over the new scenarios and commit
   `docs/notes/static-nav-latency-<date>.md`, splitting `navSnapshot`,
   `staticStreets`, `fieldReady`, and `graphFetch` as the Phase-0 bench
   already prints them.

**The decision it unlocks** (pre-baked in the Phase-0 note):

- `navSnapshot` + `staticStreets` **< 800 ms** → mark the migration "no fix
  needed", keep rows as magazine (B5).
- **≥ 800 ms** → new session B5: cache street shards + the built routing
  graph per generation and shard selection; revisit digest work. That session
  gets its own PR and its own 3-pass before/after.

**Manual deployed cross-check (the win condition's second half):** build the
app with the real `VITE_NAVIGATION_BASE` + `VITE_TRANSIT_BASE` from the
deployment env (never commit keys — `.env` only), open the deployed NYC
area, run 5 consecutive calculations with the browser console open, and
record `window.__umbraMetrics.summary` (p50/p95 and the per-phase medians)
beside the bench numbers in the note, labelled *deployed, not CI*.

---

## Magazine — measured, deliberately not scheduled

These rows have committed numbers; they become sessions only when a gate flips:

- **B1** `trainSearch` one-entry-per-search — measured **5.4×** locally
  (51.9 → 9.55 ms Node city-crossing, price-checked to float equality in
  `navigationScale.bench.ts`). Browser `trainSearch` is 8.8 ms, trigger
  200 ms → magazine.
- **B2** skip a transit mode with zero in-bbox stations — the null-scan costs
  3.2 ms/call at 16,390 stops. Magazine: concurrency + skip land with B1.
- **B3** GC/accumulation audit — `CLIMB` medians 0.79/1.05/0.99, trigger
  1.5 → not scheduled; re-read after A1/A2.
- **B4** `shadowSample` ≈ 1.14 s on 5-pt warm (fixture) — not in the Phase-0
  gate table; the next Phase-1 attribution round should add a gating row
  before anyone optimizes it.
- **B5** street-shard + graph cache — gated on A4's result (≥ 800 ms).

---

## Session dependency map

```
Phase-0 note (committed numbers)
    ├── A1 ──► A2 ──► (cumulative warm p50 < 1,000 ms on keyless fixtures)
    │              │
    │              └─(both touch useRouting.ts: sequential, separate worktrees)
    ├── A3 (routing-only; 2 PRs: curve → operating point)
    └── A4 (bench-only; parallel-safe) ──► [<800 ms → done] / [≥800 ms → B5]

Win condition: 3-pass protocol, warm p50 < 1,000 ms, deployed NYC cross-check.
```
