import assert from "node:assert/strict";
import test from "node:test";
import type { RouteEdge, StopNode } from "../src/model";
import {
  attachStructure,
  buildStructureIndex,
  classifySegment,
  osmRefFor,
  structureOf,
  type OsmRelation,
  type OsmWay,
} from "../src/structure";

/**
 * A straight run of track along a parallel of latitude, so distances along it
 * are easy to reason about: at 40.7 degrees, 0.001 degrees of longitude is
 * about 84 m.
 */
function wayAlong(id: number, lat: number, fromLon: number, toLon: number, tags: Record<string, string>): OsmWay {
  const steps = 10;
  return {
    id,
    tags,
    geometry: Array.from({ length: steps + 1 }, (_, i) => ({
      lat,
      lon: fromLon + ((toLon - fromLon) * i) / steps,
    })),
  };
}

function relation(id: number, ref: string, wayIds: number[], operator = "New York City Transit Authority"): OsmRelation {
  return {
    id,
    tags: { type: "route", route: "subway", ref, operator },
    members: wayIds.map((w) => ({ type: "way", ref: w, role: "" })),
  };
}

const stop = (id: string, lat: number, lon: number): StopNode => ({ id, name: id, lat, lon });
const edge = (from: string, to: string, route: string): RouteEdge => ({
  from,
  to,
  route,
  direction: 0,
  medianSec: 120,
  trips: 100,
  distM: 500,
});

test("structureOf reads the tag NYC actually uses, and treats no as absent", () => {
  assert.equal(structureOf({ tunnel: "yes" }), "underground");
  assert.equal(structureOf({ tunnel: "building_passage" }), "underground");
  assert.equal(structureOf({ bridge: "viaduct" }), "elevated");
  assert.equal(structureOf({ cutting: "yes" }), "open_cut");
  assert.equal(structureOf({ embankment: "yes" }), "embankment");
  // tunnel=no is a statement that it is not a tunnel, not a tunnel.
  assert.equal(structureOf({ tunnel: "no" }), null);
  assert.equal(structureOf({}), null);
});

test("express diamonds and SIR map to their OSM refs", () => {
  assert.equal(osmRefFor("6X"), "<6>");
  assert.equal(osmRefFor("7X"), "<7>");
  assert.equal(osmRefFor("FX"), "<F>");
  assert.equal(osmRefFor("SI"), "SIR");
  assert.equal(osmRefFor("G"), "G");
});

test("a segment over tunnel track reports underground", () => {
  const ways = [wayAlong(1, 40.7, -74.0, -73.99, { railway: "subway", tunnel: "yes" })];
  const index = buildStructureIndex([relation(100, "G", [1])], ways);
  const result = classifySegment(stop("a", 40.7, -74.0), stop("b", 40.7, -73.99), index.get("G"));
  assert.deepEqual(result, { underground: 1 });
});

test("a segment half tunnel and half viaduct reports both shares", () => {
  // The Culver Viaduct case: the F and G surface for part of a run.
  const ways = [
    wayAlong(1, 40.7, -74.0, -73.995, { railway: "subway", tunnel: "yes" }),
    wayAlong(2, 40.7, -73.995, -73.99, { railway: "subway", bridge: "yes" }),
  ];
  const index = buildStructureIndex([relation(100, "G", [1, 2])], ways);
  const result = classifySegment(stop("a", 40.7, -74.0), stop("b", 40.7, -73.99), index.get("G"));
  assert.ok(result, "expected a determination");
  assert.ok((result.underground ?? 0) > 0.3, `underground share ${result.underground}`);
  assert.ok((result.elevated ?? 0) > 0.3, `elevated share ${result.elevated}`);
  const sum = (result.underground ?? 0) + (result.elevated ?? 0);
  assert.ok(Math.abs(sum - 1) < 0.05, `shares should cover the segment, got ${sum}`);
});

test("a way carrying no structure tag is at grade, not unknown", () => {
  // OSM's tunnel is closed-world: absent means not a tunnel. NYC has real
  // at-grade running (the Rockaways, much of SIR) and this is how it reads.
  const ways = [wayAlong(1, 40.7, -74.0, -73.99, { railway: "subway" })];
  const index = buildStructureIndex([relation(100, "SIR", [1])], ways);
  const result = classifySegment(stop("a", 40.7, -74.0), stop("b", 40.7, -73.99), index.get("SIR"));
  assert.deepEqual(result, { at_grade: 1 });
});

test("a segment with no way of its own service nearby stays undetermined", () => {
  const ways = [wayAlong(1, 40.7, -74.0, -73.99, { railway: "subway", tunnel: "yes" })];
  const index = buildStructureIndex([relation(100, "G", [1])], ways);
  // Same track, but the edge is a mile north of it.
  const far = classifySegment(stop("a", 40.72, -74.0), stop("b", 40.72, -73.99), index.get("G"));
  assert.equal(far, undefined, "must not reach for track that is not there");
  // And a route OSM has no relation for gets nothing rather than a default.
  assert.equal(classifySegment(stop("a", 40.7, -74.0), stop("b", 40.7, -73.99), index.get("Q")), undefined);
});

test("an elevated line does not inherit the tunnel running underneath it", () => {
  // Queens Boulevard: the 7 is on a viaduct directly above the E and F tunnel.
  // Both ways occupy the same coordinates; only the route ref separates them.
  const ways = [
    wayAlong(1, 40.7, -74.0, -73.99, { railway: "subway", bridge: "yes" }),
    wayAlong(2, 40.7, -74.0, -73.99, { railway: "subway", tunnel: "yes" }),
  ];
  const index = buildStructureIndex([relation(100, "7", [1]), relation(101, "E", [2])], ways);
  const a = stop("a", 40.7, -74.0);
  const b = stop("b", 40.7, -73.99);
  assert.deepEqual(classifySegment(a, b, index.get("7")), { elevated: 1 });
  assert.deepEqual(classifySegment(a, b, index.get("E")), { underground: 1 });
});

test("PATH is excluded by operator, since it is not in our feed", () => {
  const ways = [wayAlong(1, 40.73, -74.03, -74.02, { railway: "subway", tunnel: "yes" })];
  const index = buildStructureIndex(
    [relation(100, "HOB-33", [1], "Port Authority of New York and New Jersey")],
    ways,
  );
  assert.equal(index.size, 0);
});

test("yard and crossover track is excluded by not being in any route relation", () => {
  const ways = [
    wayAlong(1, 40.7, -74.0, -73.99, { railway: "subway", tunnel: "yes" }),
    wayAlong(2, 40.7, -74.0, -73.99, { railway: "subway", service: "yard" }),
  ];
  // Only way 1 is a member of the route; the yard track is never offered.
  const index = buildStructureIndex([relation(100, "G", [1])], ways);
  assert.equal(index.get("G")?.length, 1);
  assert.deepEqual(
    classifySegment(stop("a", 40.7, -74.0), stop("b", 40.7, -73.99), index.get("G")),
    { underground: 1 },
  );
});

test("a platform in the route relation is not track, so it cannot read as at grade", () => {
  // 34 St-Herald Sq: the Q's running track is all tunnel=yes, but its platforms
  // are PTv2 members of the route relation tagged location=underground and not
  // tunnel. Read as track they put "6% above ground" on Times Sq to Union Sq.
  const ways = [
    wayAlong(1, 40.7003, -74.0, -73.99, { railway: "subway", tunnel: "yes" }),
    wayAlong(2, 40.7, -74.0, -73.998, { railway: "platform", public_transport: "platform", location: "underground" }),
  ];
  const withPlatform = relation(100, "Q", [1]);
  withPlatform.members?.push({ type: "way", ref: 2, role: "platform" });
  const index = buildStructureIndex([withPlatform], ways);
  assert.equal(index.get("Q")?.length, 1);
  assert.deepEqual(
    classifySegment(stop("a", 40.7, -74.0), stop("b", 40.7, -73.99), index.get("Q")),
    { underground: 1 },
  );
});

test("a segment only glancing its track is undetermined, not an 11% measurement", () => {
  // Without a coverage floor one matching sample out of nine yields
  // {underground: 0.11}, which reads as a measurement of a segment that was
  // 89% unseen.
  const ways = [wayAlong(1, 40.7, -74.0, -73.99, { railway: "subway", tunnel: "yes" })];
  const index = buildStructureIndex([relation(100, "G", [1])], ways);
  // Starts on the track and runs far away from it.
  const result = classifySegment(stop("a", 40.7, -73.99), stop("z", 41.5, -73.0), index.get("G"));
  assert.equal(result, undefined);
});

test("attachStructure leaves an undetermined edge untouched and counts it", () => {
  const ways = [wayAlong(1, 40.7, -74.0, -73.99, { railway: "subway", tunnel: "yes" })];
  const index = buildStructureIndex([relation(100, "G", [1])], ways);
  const stops = [stop("a", 40.7, -74.0), stop("b", 40.7, -73.99), stop("z", 41.5, -73.0)];
  const { edges, stats } = attachStructure(
    [edge("a", "b", "G"), edge("b", "z", "G")],
    stops,
    index,
  );
  assert.deepEqual(edges[0]?.structure, { underground: 1 });
  assert.equal("structure" in (edges[1] as object), false, "no empty object on an undetermined edge");
  assert.equal(stats.edges, 2);
  assert.equal(stats.determined, 1);
  assert.deepEqual(stats.byDominant, { underground: 1 });
});
