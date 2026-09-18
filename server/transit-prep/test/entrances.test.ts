import assert from "node:assert/strict";
import test from "node:test";
import { attachEntrances, type OsmNode } from "../src/entrances";
import type { StopNode } from "../src/model";
import type { OsmRelation, OsmWay } from "../src/structure";

/**
 * Grand Central, reduced to what the join sees. The 7's platform runs under
 * 42nd St; its stop area lists a street stair. The terminal's stop area lists a
 * door that sits *nearer the 7's GTFS point* than the stair — the door the
 * runtime nearest-station rule handed to the 7.
 */
const SEVEN_POINT: StopNode = { id: "subway:723", name: "Grand Central-42 St", lat: 40.751431, lon: -73.976041 };
const STREET_STAIR: OsmNode = { id: 1, lat: 40.751721, lon: -73.976001, tags: { railway: "subway_entrance" } };
const TERMINAL_DOOR: OsmNode = { id: 2, lat: 40.75158, lon: -73.97598, tags: { railway: "subway_entrance", entrance: "yes" } };

/** A closed rectangle, the way NYC maps a platform: `area=yes`. */
function platformArea(id: number, south: number, west: number, north: number, east: number, tags: Record<string, string> = {}): OsmWay {
  return {
    id,
    tags: { railway: "platform", public_transport: "platform", ...tags },
    geometry: [
      { lat: south, lon: west },
      { lat: south, lon: east },
      { lat: north, lon: east },
      { lat: north, lon: west },
      { lat: south, lon: west },
    ],
  };
}

const route = (id: number, ref: string, platformIds: number[]): OsmRelation => ({
  id,
  tags: { type: "route", route: "subway", ref, operator: "New York City Transit Authority" },
  members: platformIds.map((ref) => ({ type: "way", ref, role: "platform" })),
});

const stopArea = (id: number, members: { type: string; ref: number }[]): OsmRelation => ({
  id,
  tags: { public_transport: "stop_area" },
  members: members.map((m) => ({ ...m, role: "" })),
});

const SEVEN_PLATFORM = platformArea(10, 40.75101, -73.97709, 40.75189, -73.97504);
const TERMINAL_PLATFORM = platformArea(11, 40.7525, -73.9775, 40.7535, -73.9765);

function grandCentral(overrides: { entrances?: OsmNode[] } = {}) {
  return {
    relations: [route(100, "7", [10]), route(101, "MNR", [11])],
    ways: [SEVEN_PLATFORM, TERMINAL_PLATFORM],
    stopAreas: [
      stopArea(200, [{ type: "way", ref: 10 }, { type: "node", ref: 1 }]),
      stopArea(201, [{ type: "way", ref: 11 }, { type: "node", ref: 2 }]),
    ],
    entrances: overrides.entrances ?? [STREET_STAIR, TERMINAL_DOOR],
  };
}

const routes = (entries: [string, string[]][]) => new Map(entries.map(([id, r]) => [id, new Set(r)]));

test("a station gets its own stop area's doors, not a nearer door of another station", () => {
  const { stops } = attachEntrances([SEVEN_POINT], routes([["subway:723", ["7"]]]), grandCentral());
  assert.deepEqual(stops[0]?.entrances, [{ lat: STREET_STAIR.lat, lon: STREET_STAIR.lon }]);
});

test("the express route id finds the local's platform through osmRefFor", () => {
  // GTFS 7X is OSM <7>; a platform member of either must be found.
  const osm = grandCentral();
  osm.relations = [route(100, "<7>", [10]), route(101, "MNR", [11])];
  const { stops } = attachEntrances([SEVEN_POINT], routes([["subway:723", ["7X"]]]), osm);
  assert.equal(stops[0]?.entrances?.length, 1);
});

test("a platform tagged with the station's gtfs:stop_id beats a nearer one", () => {
  // Two platforms of the same line; the nearer belongs to a neighbour whose
  // stop area lists a different door.
  const tagged = platformArea(12, 40.7505, -73.978, 40.7507, -73.9778, { "gtfs:stop_id": "723N" });
  const osm = grandCentral();
  osm.relations = [route(100, "7", [10, 12])];
  osm.ways = [SEVEN_PLATFORM, tagged];
  osm.stopAreas = [
    stopArea(200, [{ type: "way", ref: 10 }, { type: "node", ref: 1 }]),
    stopArea(202, [{ type: "way", ref: 12 }, { type: "node", ref: 2 }]),
  ];
  const { stops, stats } = attachEntrances([SEVEN_POINT], routes([["subway:723", ["7"]]]), osm);
  assert.deepEqual(stops[0]?.entrances, [{ lat: TERMINAL_DOOR.lat, lon: TERMINAL_DOOR.lon }]);
  assert.equal(stats.byTag, 1);
});

test("doors a rider cannot use are left out, and an exit-only door is marked", () => {
  const door = (id: number, tags: Record<string, string>): OsmNode => ({
    id,
    lat: 40.7515,
    lon: -73.976,
    tags: { railway: "subway_entrance", ...tags },
  });
  const osm = grandCentral({
    entrances: [
      door(1, {}),
      // A shut hinged door, which is still a door: see isUnusable.
      door(3, { open: "no", door: "hinged" }),
      door(4, { access: "no" }),
      door(5, { access: "private" }),
      door(6, { entrance: "emergency" }),
      door(7, { entrance: "exit" }),
    ],
  });
  osm.stopAreas = [
    stopArea(200, [{ type: "way", ref: 10 }, ...[1, 3, 4, 5, 6, 7].map((ref) => ({ type: "node", ref }))]),
  ];
  const { stops } = attachEntrances([SEVEN_POINT], routes([["subway:723", ["7"]]]), osm);
  assert.deepEqual(stops[0]?.entrances, [
    { lat: 40.7515, lon: -73.976 },
    { lat: 40.7515, lon: -73.976 },
    { lat: 40.7515, lon: -73.976, exitOnly: true },
  ]);
});

test("a station OSM maps no door for publishes an empty list, and bus stops get no field", () => {
  const far: StopNode = { id: "subway:S09", name: "Tottenville", lat: 40.5127, lon: -74.2515 };
  const bus: StopNode = { id: "bus:1", name: "A stop", lat: 40.7515, lon: -73.976 };
  const { stops, stats } = attachEntrances(
    [far, bus],
    routes([
      ["subway:S09", ["SI"]],
      ["bus:1", ["M42"]],
    ]),
    grandCentral(),
  );
  assert.deepEqual(stops[0]?.entrances, []);
  assert.equal("entrances" in (stops[1] as object), false);
  assert.deepEqual(stats.unresolved, ["subway:S09"]);
});

test("a door listed by two stop areas of one station is published once", () => {
  const osm = grandCentral();
  osm.stopAreas = [
    stopArea(200, [{ type: "way", ref: 10 }, { type: "node", ref: 1 }]),
    stopArea(203, [{ type: "way", ref: 10 }, { type: "node", ref: 1 }]),
  ];
  const { stops } = attachEntrances([SEVEN_POINT], routes([["subway:723", ["7"]]]), osm);
  assert.equal(stops[0]?.entrances?.length, 1);
});
