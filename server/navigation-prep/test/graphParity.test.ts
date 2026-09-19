import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { OverpassWayElement } from "../../../app/lib/overpass";
import { buildRoutingGraphFromElements } from "../../../app/lib/overpass";
import { buildStreetGraph } from "../src/graph";
import { parseRoads } from "../src/pbf";
import { encodeTestPbf, type TestNode, type TestWay } from "./pbfWriter";

/**
 * The producer, parsing real PBF bytes it encoded itself, must construct the
 * same graph `buildRoutingGraphFromElements` constructs from the equivalent
 * Overpass JSON — same ids, coordinates, intersection flags, bidirectional
 * edges, per-way tags, and distances. Runs under vitest because the app
 * builder reads `import.meta.env`.
 */

const NODES: TestNode[] = [
  { id: 1, lat: 40.755, lon: -73.9885 },
  { id: 2, lat: 40.7555, lon: -73.987 },
  { id: 3, lat: 40.756, lon: -73.9862 },
  { id: 4, lat: 40.7558, lon: -73.988 },
  { id: 5, lat: 40.7562, lon: -73.9857 },
  // Far outside the retention bounds: must be ignored, not carried.
  { id: 999, lat: 43.5, lon: -79.4 },
];

/** 2005 is excluded by the Overpass query itself (area=yes). */
const QUERY_EXCLUDED = new Set([2005]);

const WAYS: TestWay[] = [
  { id: 2001, refs: [1, 2, 3], tags: { highway: "residential", surface: "asphalt" } },
  { id: 2002, refs: [2, 3], tags: { highway: "pedestrian", foot: "yes" } },
  { id: 2003, refs: [2, 4], tags: { highway: "steps", surface: "concrete", access: "yes" } },
  { id: 2004, refs: [3, 5], tags: { highway: "footway", surface: "concrete", foot: "designated" } },
  { id: 2005, refs: [3, 5, 3], tags: { highway: "pedestrian", area: "yes" } },
  { id: 2006, refs: [2, 999], tags: { highway: "footway" } },
  { id: 2007, refs: [1, 2], tags: { highway: "service", service: "driveway" } },
  // Passes the filter with a closed pedestrian ring: counted for intersection
  // membership, emits no edges (the client's plaza skip).
  // 2006 reaches a node far outside the support bounds: the Overpass query
  // returns such a way too, so this stub acts as the query result it mirrors.
  { id: 2008, refs: [3, 5, 3], tags: { highway: "pedestrian", name: "plaza" } },
];

const receivedWays = WAYS.filter((way) => !QUERY_EXCLUDED.has(way.id));

function element(way: (typeof WAYS)[number]): OverpassWayElement {
  return {
    id: way.id,
    nodes: way.refs,
    geometry: way.refs.map((id) => {
      const node = NODES.find((candidate) => candidate.id === id)!;
      return { lat: node.lat, lon: node.lon };
    }),
    tags: way.tags,
  };
}

describe("street graph parity", () => {
  let ours: ReturnType<typeof buildStreetGraph>;
  let parsed: Awaited<ReturnType<typeof parseRoads>>;
  let reference: ReturnType<typeof buildRoutingGraphFromElements>;

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "nav-prep-parity-"));
    const path = join(directory, "fixture.osm.pbf");
    await writeFile(path, encodeTestPbf(NODES, WAYS));
    parsed = await parseRoads(path);
    ours = buildStreetGraph(parsed.ways, parsed.coords);
    reference = buildRoutingGraphFromElements(receivedWays.map(element));
  });

  it("reads the replicated header cookie", () => {
    expect(parsed.replicationTimestamp).toBe(1_758_000_000);
  });

  it("retains exactly the ways the highway filter admits", () => {
    expect(new Set(parsed.ways.map((way) => way.id))).toEqual(
      new Set(receivedWays.map((way) => way.id)),
    );
  });

  it("reproduces nodes and intersection membership exactly", () => {
    // Node 999 (way 2006's far end) carries no coordinate inside the keep
    // bounds, which is the producer's analogue of an unreachable `geom[i]` in
    // the browser path: reported as a dropped-segment count, not carried.
    expect(ours.stats.segmentsMissingCoords).toBe(2);
    expect([...ours.nodes.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    for (const [id, node] of reference.nodes) {
      if (!ours.nodes.has(id)) continue;
      const mine = ours.nodes.get(id);
      assert.ok(mine, `node ${id}`);
      expect(mine.lat).toBeCloseTo(node.lat, 9);
      expect(mine.lon).toBeCloseTo(node.lon, 9);
      expect(mine.isIntersection).toBe(node.isIntersection);
    }
  });

  it("reproduces directed edges, distances, and tags exactly", () => {
    expect(ours.edges.length).toBe(12);
    for (const [id, outgoing] of reference.adj) {
      if (!ours.nodes.has(id)) continue;
      const mine = [...ours.edges]
        .filter((edge) => edge.from === id)
        .sort((a, b) => a.to - b.to || a.id.localeCompare(b.id));
      const reachable = outgoing.filter((edge) => ours.nodes.has(edge.toId));
      const theirs = [...reachable].sort((a, b) => a.toId - b.toId || a.distanceM - b.distanceM);
      expect(mine.length).toBe(theirs.length);
      mine.forEach((edge, index) => {
        expect(edge.to).toBe(theirs[index].toId);
        expect(edge.distanceM).toBeCloseTo(theirs[index].distanceM, 6);
        expect(edge.tags.highway).toBe(theirs[index].highway);
        expect(edge.tags.surface ?? undefined).toBe(theirs[index].surface);
        expect(edge.tags.smoothness ?? undefined).toBe(theirs[index].smoothness);
        expect(edge.tags.cycleway ?? undefined).toBe(theirs[index].cycleway);
        expect(edge.tags.bicycle ?? undefined).toBe(theirs[index].bicycle);
        expect(edge.tags.foot ?? undefined).toBe(theirs[index].foot);
        expect(edge.tags.access ?? undefined).toBe(theirs[index].access);
      });
    }
  });

  it("applies the closed pedestrian plaza skip", () => {
    // 2008 is a closed pedestrian way the query admits: it counts toward the
    // intersection flag on 3 and 5 but must not add plaza ring edges.
    expect(ours.stats.closedPedestrianWaysSkipped).toBe(1);
    expect(ours.nodes.get(5)!.isIntersection).toBe(true); // member of 2004 and 2008
  });
});
