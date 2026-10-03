/**
 * H1 traversal-time exposure — `paretoRoutes` with `timeAware`.
 *
 * The fixture is the case the checkpoint exists for: a branch that is the
 * most-shadowed route *at departure* is the most-sunlit one *by the time the
 * walker arrives*, and vice versa. The static run prices both legs at the
 * frozen `shadowFactor` (the departure-time sample); the time-aware run
 * prices each leg at the bucket of its arrival (H1 semantics: end-of-edge
 * arrival, walk speed from `TRAVEL_MODE_POLICIES`, 1.4 m/s).
 *
 * All graphs are hand-crafted and deterministic — no browser, network, or
 * randomness. Run with: npm test
 */

import { describe, it, expect } from "vitest";
import { paretoRoutes, type RoutingGraph, type OsmNode, type GraphEdge } from "../routing";

/** The documented H1 bucket width. */
const BUCKET_MS = 15 * 60 * 1000;

const edge = (
  toId: number,
  distanceM: number,
  shadowFactor: number,
  timeShadow?: number[],
): GraphEdge => ({ toId, distanceM, shadowFactor, ...(timeShadow ? { timeShadow } : {}) });

/**
 * Two equal-length branches with asymmetric legs (600 m then 1800 m):
 *
 *   1 --[600m, X]--> 2 --[1800m, X]--> 4   (branch X: north street)
 *   1 --[600m, Y]--> 3 --[1800m, Y]--> 4   (branch Y: south street)
 *
 * The walker reaches node 2/3 at ~429 s (bucket 0) and node 4 at
 * ~1715 s (bucket 1), so the short first leg is priced in bucket 0 and
 * the long second leg in bucket 1.
 *
 *   X: shadowFactor 0.9, timeShadow [0.9, 0.0]  — shadowed at departure, bare by arrival
 *   Y: shadowFactor 0.1, timeShadow [0.1, 0.9]  — bare at departure, shadowed by arrival
 */
function makeSunShiftGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0, lon: 0 }],
    [2, { id: 2, lat: 0.00539, lon: 0 }],
    [3, { id: 3, lat: 0, lon: 0.00539 }],
    [4, { id: 4, lat: 0.02156, lon: 0.02156 }],
  ]);
  const adj: Map<number, GraphEdge[]> = new Map([
    [1, [edge(2, 600, 0.9, [0.9, 0.0]), edge(3, 600, 0.1, [0.1, 0.9])]],
    [2, [edge(1, 600, 0.9, [0.9, 0.0]), edge(4, 1800, 0.9, [0.9, 0.0])]],
    [3, [edge(1, 600, 0.1, [0.1, 0.9]), edge(4, 1800, 0.1, [0.1, 0.9])]],
    [4, [edge(2, 1800, 0.9, [0.9, 0.0]), edge(3, 1800, 0.1, [0.1, 0.9])]],
  ]);
  return { nodes, adj };
}

/** The option that visits `via` — robust to representative ordering. */
const viaOption = (results: ReturnType<typeof paretoRoutes>, via: number) =>
  results.find((r) => r.nodeIds.includes(via));

describe("paretoRoutes time-aware pricing (H1)", () => {
  it("picks the branch that is shadowed by arrival, not at departure", () => {
    const g = makeSunShiftGraph();

    // Static baseline: every leg priced at the frozen departure sample, so
    // the north street's 0.9 wins the most-shadowed slot.
    const staticResults = paretoRoutes(g, 1, 4, {});
    const staticBest = staticResults.reduce((a, b) =>
      b.shadowCoverage > a.shadowCoverage ? b : a);
    expect(staticBest.nodeIds).toEqual([1, 2, 4]);
    expect(staticBest.shadowCoverage).toBeCloseTo(0.9);

    // Time-aware: the short first legs fall in bucket 0, the long second
    // legs in bucket 1 (arrival ≈ 1715 s). Branch X keeps only 0.9·600
    // shadowed metres (coverage 0.225); branch Y keeps 0.1·600 + 0.9·1800
    // (coverage 0.7) at the same 2400 m — X is dominated and drops off the
    // front entirely.
    const timed = paretoRoutes(g, 1, 4, { timeAware: { bucketMs: BUCKET_MS, bucketCount: 2 } });
    const timedBest = timed.reduce((a, b) =>
      b.shadowCoverage > a.shadowCoverage ? b : a);
    expect(timedBest.nodeIds).toEqual([1, 3, 4]);
    expect(timedBest.shadowCoverage).toBeCloseTo(0.7);

    // The flip is attributable to specific edges: branch X's long second
    // leg (2→4) is priced at bucket 1, where it is bare, while Y's same
    // position leg is priced at its bucket-1 shade.
    expect(viaOption(timed, 2)).toBeUndefined();
    expect(timed.length).toBeGreaterThan(0);
    for (const r of timed) expect(r.nodeIds).toEqual([1, 3, 4]);
  });

  it("degenerates to the static answer when one bucket covers the horizon", () => {
    const g = makeSunShiftGraph();
    const bucketOne = paretoRoutes(g, 1, 4, {
      timeAware: { bucketMs: BUCKET_MS, bucketCount: 1 },
    });

    // Every arrival clamps into bucket 0, whose factors equal the frozen
    // `shadowFactor` sample here — so a one-bucket sweep must reproduce the
    // static run exactly, option for option.
    const staticResults = paretoRoutes(g, 1, 4, {});
    expect(bucketOne.map((r) => r.nodeIds)).toEqual(staticResults.map((r) => r.nodeIds));
    expect(bucketOne.map((r) => r.shadowCoverage)).toEqual(
      staticResults.map((r) => r.shadowCoverage),
    );
  });

  it("clamps arrivals past the swept horizon to the last bucket", () => {
    // Linear 1→2→4, legs 3000 m (~2143 s each). Both arrivals fall past
    // bucket 1, so both legs are priced at the horizon's last bucket.
    const nodes = new Map<number, OsmNode>([
      [1, { id: 1, lat: 0, lon: 0 }],
      [2, { id: 2, lat: 0.027, lon: 0 }],
      [4, { id: 4, lat: 0.027, lon: 0.027 }],
    ]);
    const adj = new Map<number, GraphEdge[]>([
      [1, [edge(2, 3000, 0.9, [0.9, 0.0])]],
      [2, [edge(1, 3000, 0.9, [0.9, 0.0]), edge(4, 3000, 0.9, [0.9, 0.0])]],
      [4, [edge(2, 3000, 0.9, [0.9, 0.0])]],
    ]);
    const g: RoutingGraph = { nodes, adj };

    const timed = paretoRoutes(g, 1, 4, {
      timeAware: { bucketMs: BUCKET_MS, bucketCount: 2 },
    });
    // 3000 m / 1.4 m/s ≈ 2143 s → floor(2143/900) = 2 → clamped to bucket 1.
    expect(timed[0].shadowCoverage).toBeCloseTo(0.0);

    const frozen = paretoRoutes(g, 1, 4, {});
    expect(frozen[0].shadowCoverage).toBeCloseTo(0.9);
  });

  it("falls back to the frozen factor on edges the caller never swept", () => {
    // Leg 1 carries a bucket table; leg 2 does not (a rain/sketch/fixture-era
    // edge). The unswept leg keeps its static factor instead of reading a
    // bucket the sweep never computed.
    const nodes = new Map<number, OsmNode>([
      [1, { id: 1, lat: 0, lon: 0 }],
      [2, { id: 2, lat: 0.01078, lon: 0 }],
      [4, { id: 4, lat: 0.01078, lon: 0.02156 }],
    ]);
    const adj = new Map<number, GraphEdge[]>([
      [1, [edge(2, 1200, 0.9, [0.9, 0.0])]],
      [2, [edge(1, 1200, 0.9, [0.9, 0.0]), edge(4, 1200, 0.9)]],
      [4, [edge(2, 1200, 0.9)]],
    ]);
    const g: RoutingGraph = { nodes, adj };

    const timed = paretoRoutes(g, 1, 4, {
      timeAware: { bucketMs: BUCKET_MS, bucketCount: 2 },
    });
    // Leg 1: arrival ≈ 857 s → bucket 0 (0.9). Leg 2 (unswept): 0.9.
    // Coverage = (0.9·1200 + 0.9·1200) / 2400 = 0.9 — identical to static.
    expect(timed[0].shadowCoverage).toBeCloseTo(0.9);
  });

  it("keeps a later-arriving label whose remaining edges are the shaded ones", () => {
    // The dominance trap the H1 brief warns about: an earlier arrival is NOT
    // automatically better. Two paths reach node 5 — a fast one (2400 m,
    // arriving ≈ 1714 s, bucket 1) and a slow one (3600 m, arriving ≈ 2571 s,
    // bucket 2). The slow path's late legs — reached in bucket 2 — are the
    // shaded ones, so under the H2 duration objective it carries *less* sun
    // time than the fast one despite the extra distance. A dominance rule
    // that lets the fast label at node 5 prune the slow one throws the
    // better route away.
    const bare = (toId: number, distanceM: number): GraphEdge =>
      edge(toId, distanceM, 0, [0, 0, 0]);
    const lateShade = (toId: number, distanceM: number): GraphEdge =>
      edge(toId, distanceM, 0, [0, 0, 1]);
    // Coordinates roughly collinear with the declared distances so the
    // straight-line heuristic stays admissible and the detour-budget prune
    // does not kill the fixture before the search runs.
    const nodes = new Map<number, OsmNode>([
      [1, { id: 1, lat: 0, lon: 0 }],
      [2, { id: 2, lat: 0.0109, lon: 0 }],
      [3, { id: 3, lat: 0.01171, lon: 0.0001 }],
      [4, { id: 4, lat: 0.02342, lon: 0.0001 }],
      [5, { id: 5, lat: 0.0343, lon: 0 }],
      [6, { id: 6, lat: 0.0352, lon: 0 }],
    ]);
    const adj: Map<number, GraphEdge[]> = new Map([
      [1, [bare(2, 1210), lateShade(3, 1300)]],
      [2, [bare(1, 1210), bare(5, 1210)]],
      [3, [lateShade(1, 1300), lateShade(4, 1300)]],
      [4, [lateShade(3, 1300), lateShade(5, 1300)]],
      [5, [bare(2, 1210), lateShade(4, 1300), lateShade(6, 100)]],
      [6, [lateShade(5, 100)]],
    ]);
    const g: RoutingGraph = { nodes, adj };

    const timed = paretoRoutes(g, 1, 6, { timeAware: { bucketMs: BUCKET_MS, bucketCount: 3 } });
    const best = timed.reduce((a, b) =>
      (b.exposure?.exposedDurationSec ?? Infinity) < (a.exposure?.exposedDurationSec ?? Infinity) ? b : a);
    // The slow path's first leg (arrival ≈ 929 s) is still in bucket 1 and
    // bare, but every leg after it lands in bucket 2, shaded — so it carries
    // ≈ 929 s of sun despite 4,000 m of walking. The fast path (2,420 m) is
    // bare the whole way (≈ 1,729 s). The slow path must survive node 5 and
    // win on sun time.
    expect(best.nodeIds).toEqual([1, 3, 4, 5, 6]);
    expect(best.exposure?.exposedDurationSec).toBeCloseTo(1300 / 1.4, 1);
  });
});
