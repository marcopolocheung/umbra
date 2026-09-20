/**
 * Pins the seeded static street/building shard generator the latency-
 * attribution bench (session A4) serves behind `VITE_NAVIGATION_BASE`.
 *
 * `e2e/fixtures/navigationShards.ts` builds it for the browser bench's stub
 * network; this test holds the contract around it: the exact counts the
 * bench's scenario names quote, the digest chain the client would verify, the
 * pinned byte stream (one seed, one dataset — a before/after comparison cannot
 * drift because a fixture rewrote itself), the per-shard byte budget the
 * contract enforces, and the geometry facts the benchmarks rely on (both
 * waypoint pairs stay inside the verified selection, the NYC-scale selection
 * is the full 16,800-node city slice, and the grid actually connects them).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dijkstra, type RoutingGraph } from "../../routing";
import {
  buildNavigationShardFixture,
  NAV_STATIC_COUNTS,
  navigationFixtureArtifacts,
} from "../../../../e2e/fixtures/navigationShards";
import {
  MAX_STREET_SHARD_BYTES,
  parseNavigationBuildingShard,
  parseNavigationManifest,
  parseNavigationPointer,
  parseNavigationStreetShard,
  type NavigationManifest,
} from "../shardContract";
import type { GeoBounds } from "../shardContract";
import {
  selectNavigationShardsForBoxes,
  zoneAround,
  type NavigationShardSelection,
} from "../remoteNavigation";
import { buildRoutingGraphFromStreetShards } from "../routingGraphAdapter";

const sha256 = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

// The browser bench's waypoint pairs (`e2e/helpers/scenario.ts`), duplicated
// here rather than importing the Playwright-shaped helper module — the same
// concession `transitShardFixture.test.ts` makes.
const WAYPOINT_A: [number, number] = [-73.9855, 40.753];
const WAYPOINT_B: [number, number] = [-73.9825, 40.755];
const TRANSIT_WAYPOINT_A: [number, number] = [-73.9871, 40.7518];
const TRANSIT_WAYPOINT_B: [number, number] = [-73.9809, 40.7562];

// The route bboox `useRouting` builds around the transit pair plus its two
// 2000 m access zones — the selection the NYC-scale scenario's graph comes from.
const ACCESS_RADIUS_M = 2000;

const haversineM = (a: [number, number], b: [number, number]) => {
  const R = 6_371_000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const la = (a[1] * Math.PI) / 180;
  const lb = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function fixture() {
  const artifacts = buildNavigationShardFixture({});
  const pointer = parseNavigationPointer(JSON.parse(artifacts.pointer));
  const manifest = parseNavigationManifest(JSON.parse(artifacts.manifest), pointer.generation);
  const streets = manifest.streetShards.map((ref) =>
    parseNavigationStreetShard(
      JSON.parse(artifacts.streetShards.get(ref.key)!),
      ref,
      pointer.generation,
    ),
  );
  const buildings = manifest.buildingShards.map((ref) =>
    parseNavigationBuildingShard(
      JSON.parse(artifacts.buildingShards.get(ref.key)!),
      ref,
      pointer.generation,
    ),
  );
  return { artifacts, pointer, manifest, streets, buildings };
}

function benchBbox(a: [number, number], b: [number, number]): GeoBounds {
  const lats = [a[1], b[1]];
  const lngs = [a[0], b[0]];
  return {
    south: Math.min(...lats) - 0.005,
    west: Math.min(...lngs) - 0.005,
    north: Math.max(...lats) + 0.005,
    east: Math.max(...lngs) + 0.005,
  };
}

function selection(
  manifest: NavigationManifest,
  bbox: GeoBounds,
  extras: GeoBounds[] = [],
): NavigationShardSelection {
  const picked = selectNavigationShardsForBoxes(manifest, bbox, extras);
  if (!picked) throw new Error("bench bbox fell outside the fixture's verified support");
  return picked;
}

function graphFor(
  artifacts: ReturnType<typeof buildNavigationShardFixture>,
  refs: NavigationShardSelection,
  generation: string,
): RoutingGraph {
  const shards = refs.streets.map((ref) =>
    parseNavigationStreetShard(JSON.parse(artifacts.streetShards.get(ref.key)!), ref, generation),
  );
  return buildRoutingGraphFromStreetShards(shards);
}

describe("buildNavigationShardFixture — digest chain", () => {
  it("pins the exact byte stream it serves", () => {
    const { artifacts, pointer } = fixture();
    expect(sha256(artifacts.manifest)).toBe(pointer.manifestSha256);
    // One seed, one dataset. Updating this constant is a deliberate fixture
    // change; nothing routine gets to rewrite it silently.
    expect(pointer.manifestSha256).toBe(
      "1dab22e22681f6d9dfddf98727a41707e2aecdcf9bcbc53fb35b6763ff82c6cd",
    );
    for (const ref of JSON.parse(artifacts.manifest).streetShards) {
      expect(sha256(artifacts.streetShards.get(ref.key)!)).toBe(ref.sha256);
      expect(Buffer.byteLength(artifacts.streetShards.get(ref.key)!, "utf8")).toBe(ref.bytes);
    }
    for (const ref of JSON.parse(artifacts.manifest).buildingShards) {
      expect(sha256(artifacts.buildingShards.get(ref.key)!)).toBe(ref.sha256);
      expect(Buffer.byteLength(artifacts.buildingShards.get(ref.key)!, "utf8")).toBe(ref.bytes);
    }
    expect(sha256(artifacts.notices)).toBe(JSON.parse(artifacts.manifest).noticesSha256);
  });

  it("keeps every street shard inside the contract's byte budget", () => {
    const { artifacts } = fixture();
    for (const body of artifacts.streetShards.values()) {
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_STREET_SHARD_BYTES);
    }
  });

  it("parses every artifact through the production parsers", () => {
    const { pointer, manifest, streets, buildings } = fixture();
    expect(pointer.dataset).toBe("nyc-navigation");
    expect(manifest.streetShards.length).toBe(NAV_STATIC_COUNTS.streetShards);
    expect(streets.length).toBe(NAV_STATIC_COUNTS.streetShards);
    expect(buildings.reduce((sum, shard) => sum + shard.buildings.length, 0)).toBe(
      NAV_STATIC_COUNTS.buildings,
    );
  });
});

describe("buildNavigationShardFixture — pinned counts", () => {
  it("merges to the city-scale node and edge counts the benchmark names", () => {
    const { manifest, streets } = fixture();
    const graph = buildRoutingGraphFromStreetShards(streets);
    expect(graph.nodes.size).toBe(NAV_STATIC_COUNTS.streetNodes);
    const directed = [...graph.adj.values()].reduce((sum, edges) => sum + edges.length, 0);
    expect(directed).toBe(NAV_STATIC_COUNTS.streetEdges);
    // Every node belongs to an owned rect exactly once; ghost seam nodes are
    // per-shard duplicates that the merge dedupes by id.
    expect(streets.reduce((sum, shard) => sum + shard.nodes.length, 0)).toBeGreaterThan(
      NAV_STATIC_COUNTS.streetNodes,
    );
    expect(manifest.buildingShards.length).toBe(1);
  });

  it("counts every building ring and missing height the contract asks refs to publish", () => {
    const { manifest, buildings } = fixture();
    const ref = manifest.buildingShards[0];
    const shard = buildings[0];
    expect(shard.buildings.length).toBe(NAV_STATIC_COUNTS.buildings);
    expect(shard.buildings.reduce((sum, building) => sum + building.rings.length, 0)).toBe(
      NAV_STATIC_COUNTS.buildingRings,
    );
    expect(shard.buildings.filter((building) => building.heightM === null).length).toBe(
      ref.missingHeights,
    );
  });
});

describe("buildNavigationShardFixture — determinism", () => {
  it("reproduces the exact same bytes for the same inputs", () => {
    const one = buildNavigationShardFixture({});
    const two = buildNavigationShardFixture({});
    expect(one.pointer).toBe(two.pointer);
    expect(one.manifest).toBe(two.manifest);
    expect(one.notices).toBe(two.notices);
    expect([...one.streetShards].map(([key, body]) => `${key}:${body}`)).toEqual(
      [...two.streetShards].map(([key, body]) => `${key}:${body}`),
    );
  });

  it("changes the bytes when the seed changes", () => {
    const one = buildNavigationShardFixture({});
    const two = buildNavigationShardFixture({ seed: 446 });
    expect(one.manifest).not.toBe(two.manifest);
    expect(one.buildingShards.get("buildings/midtown.json")).not.toBe(
      two.buildingShards.get("buildings/midtown.json"),
    );
  });

  it("serves scale artifacts only when asked", () => {
    expect(navigationFixtureArtifacts("scale")).not.toBeNull();
    expect(navigationFixtureArtifacts("off")).toBeNull();
  });
});

describe("buildNavigationShardFixture — geometry facts the bench relies on", () => {
  it("selects one midtown cell for the 2-point walk pair", () => {
    const { artifacts, manifest, pointer } = fixture();
    const picked = selection(manifest, benchBbox(WAYPOINT_A, WAYPOINT_B));
    const graph = graphFor(artifacts, picked, pointer.generation);
    // One z14-style cell: 70 × 60 nodes.
    expect(picked.streets.length).toBe(1);
    // One cell: its 70 × 60 rect plus the seam ghosts each owned crossing edge
    // drags in (70 south-going and 60 east-going targets).
    expect(graph.nodes.size).toBe(70 * 60 + 70 + 60);
  });

  it("selects the full 16,800-node city slice for the NYC-scale pair and its access zones", () => {
    const { artifacts, manifest, pointer } = fixture();
    const picked = selection(manifest, benchBbox(TRANSIT_WAYPOINT_A, TRANSIT_WAYPOINT_B), [
      zoneAround(TRANSIT_WAYPOINT_A[0], TRANSIT_WAYPOINT_A[1], ACCESS_RADIUS_M),
      zoneAround(TRANSIT_WAYPOINT_B[0], TRANSIT_WAYPOINT_B[1], ACCESS_RADIUS_M),
    ]);
    const graph = graphFor(artifacts, picked, pointer.generation);
    expect(picked.streets.length).toBe(NAV_STATIC_COUNTS.streetShards);
    expect(graph.nodes.size).toBe(NAV_STATIC_COUNTS.streetNodes);
  });

  it("routes both waypoint pairs over the seeded grid (the no-fallback guard)", () => {
    const { artifacts, manifest, pointer } = fixture();
    const nyc = selection(manifest, benchBbox(TRANSIT_WAYPOINT_A, TRANSIT_WAYPOINT_B), [
      zoneAround(TRANSIT_WAYPOINT_A[0], TRANSIT_WAYPOINT_A[1], ACCESS_RADIUS_M),
      zoneAround(TRANSIT_WAYPOINT_B[0], TRANSIT_WAYPOINT_B[1], ACCESS_RADIUS_M),
    ]);
    const graph = graphFor(artifacts, nyc, pointer.generation);

    const nearest = (target: [number, number]) => {
      let best: { id: number } | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const node of graph.nodes.values()) {
        const d = haversineM(target, [node.lon, node.lat]);
        if (d < bestD) {
          bestD = d;
          best = node;
        }
      }
      return { node: best!, distanceM: bestD };
    };

    for (const [a, b] of [
      [WAYPOINT_A, WAYPOINT_B],
      [TRANSIT_WAYPOINT_A, TRANSIT_WAYPOINT_B],
    ] as Array<[[number, number], [number, number]]>) {
      const from = nearest(a);
      const to = nearest(b);
      // Both waypoints sit inside the grid, under a half lattice step (~31 m).
      expect(from.distanceM).toBeLessThan(32);
      expect(to.distanceM).toBeLessThan(32);
      const route = dijkstra(graph, from.node.id, to.node.id, 0.5);
      expect(route, "waypoint pair must route over the static shard grid").not.toBeNull();
      expect(route!.nodeIds.length).toBeGreaterThanOrEqual(2);
    }
  });
});
