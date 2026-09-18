import assert from "node:assert/strict";
import test from "node:test";
import type { StopNode, TransferEdge } from "../src/model";
import { haversineMeters } from "../src/util";
import { rederiveWalked } from "../src/verify";
import {
  buildFootwayGraph,
  type FootwayWay,
  promoteWalkable,
  WALK_PARAMS,
  walkedMinSec,
  walkStub,
} from "../src/walkability";

/** Metres east/north of an origin, as a point. Flat is fine at this scale. */
const LAT0 = 40.75;
const LON0 = -73.99;
const at = (eastM: number, northM: number) => ({
  lat: LAT0 + northM / 111_195,
  lon: LON0 + eastM / (111_195 * Math.cos((LAT0 * Math.PI) / 180)),
});

let nextNode = 1;
/** A way through the given points; points shared by value share a node. */
const nodeIds = new Map<string, number>();
function way(id: number, points: [number, number][]): FootwayWay {
  const nodes: number[] = [];
  const coords: number[] = [];
  for (const [east, north] of points) {
    const key = `${east},${north}`;
    let node = nodeIds.get(key);
    if (node === undefined) {
      node = nextNode++;
      nodeIds.set(key, node);
    }
    const { lat, lon } = at(east, north);
    nodes.push(node);
    coords.push(lat, lon);
  }
  return { id, nodes, coords };
}

const station = (entrances?: StopNode["entrances"]): StopNode => ({
  id: "subway:P1",
  name: "Alpha",
  ...at(0, 0),
  ...(entrances ? { entrances } : {}),
});
const door = (east: number, north: number, exitOnly?: true) => ({
  ...at(east, north),
  ...(exitOnly ? { exitOnly } : {}),
});
const stop = (east: number, north: number): StopNode => ({ id: "bus:S1", name: "Stop", ...at(east, north) });

test("a stop the pavement reaches directly is walked, and the walk is door plus street", () => {
  // Door 30 m east of the station point, pavement east 100 m to the stop.
  const graph = buildFootwayGraph([way(1, [[30, 0], [130, 0]])]);
  const result = walkStub(graph, station([door(30, 0)]), stop(130, 0), true, WALK_PARAMS);
  assert.ok("walkM" in result);
  // 30 m inside (station point → door, straight) + 100 m of pavement.
  assert.ok(Math.abs(result.walkM - 130) <= 1, `walkM ${result.walkM}`);
  assert.equal(walkedMinSec(result.walkM, 1.4), Math.ceil(result.walkM / 1.4));
});

test("a grid corner is walked; the way round an expressway is not", () => {
  // Stop 100 m east and 100 m north of the door: the L is 200 m against a
  // 141 m diagonal, ratio √2, inside 1.5 × 141 + 50.
  const corner = buildFootwayGraph([way(1, [[0, 0], [100, 0], [100, 100]])]);
  assert.ok("walkM" in walkStub(corner, station([door(0, 0)]), stop(100, 100), true, WALK_PARAMS));

  // Stop 100 m north across a barrier; the only crossing is 300 m east.
  // 700 m of walk for a 100 m straight line.
  const barrier = buildFootwayGraph([way(2, [[0, 0], [300, 0], [300, 100], [0, 100]])]);
  assert.deepEqual(walkStub(barrier, station([door(0, 0)]), stop(0, 100), true, WALK_PARAMS), {
    refused: "detour",
  });
});

test("any door that makes it will do, and the shortest overall wins", () => {
  // Door A is on the far side of the barrier, door B is on the stop's side.
  const graph = buildFootwayGraph([
    way(1, [[0, -20], [300, -20], [300, 100], [0, 100]]),
    way(2, [[50, 60], [50, 100], [0, 100]]),
  ]);
  const result = walkStub(graph, station([door(0, -20), door(50, 60)]), stop(0, 100), true, WALK_PARAMS);
  assert.ok("walkM" in result);
  const insideB = haversineMeters(LAT0, LON0, at(50, 60).lat, at(50, 60).lon);
  // Door B: 40 m north then 50 m west along the pavement.
  assert.ok(Math.abs(result.walkM - (insideB + 90)) <= 1, `walkM ${result.walkM}`);
});

test("an exit-only door carries a rider out but not in", () => {
  const graph = buildFootwayGraph([way(1, [[30, 0], [130, 0]])]);
  const exitOnly = station([door(30, 0, true)]);
  assert.ok("walkM" in walkStub(graph, exitOnly, stop(130, 0), true, WALK_PARAMS));
  assert.deepEqual(walkStub(graph, exitOnly, stop(130, 0), false, WALK_PARAMS), { refused: "noDoor" });
});

test("a station with no door on file walks nothing, whatever the pavement says", () => {
  const graph = buildFootwayGraph([way(1, [[0, 0], [130, 0]])]);
  assert.deepEqual(walkStub(graph, station([]), stop(130, 0), true, WALK_PARAMS), { refused: "noDoor" });
  // Absent (a build without the door join) is no better than empty.
  assert.deepEqual(walkStub(graph, station(), stop(130, 0), true, WALK_PARAMS), { refused: "noDoor" });
});

test("a stop or door off the network is refused as such, not as a detour", () => {
  const graph = buildFootwayGraph([way(1, [[30, 0], [130, 0]])]);
  assert.deepEqual(walkStub(graph, station([door(30, 0)]), stop(130, 40), true, WALK_PARAMS), {
    refused: "stopOffNetwork",
  });
  assert.deepEqual(walkStub(graph, station([door(30, 40)]), stop(130, 0), true, WALK_PARAMS), {
    refused: "doorsOffNetwork",
  });
});

test("a stop on a pavement fragment still joins the crossing beside it", () => {
  // The nearest way to the stop (3 m) is a 10 m sliver that meets nothing;
  // the connected pavement passes 12 m away. Snapping to the nearest way
  // alone would strand the stop.
  const graph = buildFootwayGraph([
    way(1, [[30, 0], [130, 0]]),
    way(2, [[125, 15], [135, 15]]),
  ]);
  assert.ok("walkM" in walkStub(graph, station([door(30, 0)]), stop(130, 12), true, WALK_PARAMS));
});

test("promoteWalkable rewrites only the spatial stubs it can walk, per direction", () => {
  const graph = buildFootwayGraph([way(1, [[30, 0], [130, 0]])]);
  const stops = [station([door(30, 0, true)]), stop(130, 0)];
  const transfers: TransferEdge[] = [
    { from: "subway:P1", to: "subway:P2", minSec: 180, kind: "gtfs" },
    { from: "subway:P1", to: "bus:S1", minSec: 93, kind: "spatial" },
    { from: "bus:S1", to: "subway:P1", minSec: 93, kind: "spatial" },
  ];
  const { transfers: out, stats } = promoteWalkable(transfers, stops, graph);
  assert.deepEqual(out[0], transfers[0]);
  assert.equal(out[1]?.kind, "walked");
  assert.equal(out[1]?.minSec, walkedMinSec(out[1]?.walkM as number, 1.4));
  // The only door is exit-only, so the change onto the subway stays a guess.
  assert.deepEqual(out[2], transfers[2]);
  assert.equal(stats.candidates, 2);
  assert.equal(stats.walked, 1);
  assert.equal(stats.refused.noDoor, 1);
  assert.equal(stats.stationsWalkedOut, 1);
  assert.equal(stats.stationsWalkedIn, 0);
});

test("verify re-routes every stub and rejects any published answer it cannot reproduce", () => {
  const graph = buildFootwayGraph([way(1, [[30, 0], [130, 0]])]);
  const stops = [station([door(30, 0)]), stop(130, 0)];
  const { transfers } = promoteWalkable(
    [
      { from: "subway:P1", to: "bus:S1", minSec: 93, kind: "spatial" },
      { from: "bus:S1", to: "subway:P1", minSec: 93, kind: "spatial" },
    ],
    stops,
    graph,
  );
  const shard = (list: TransferEdge[]) => ({ stops, edges: [], routes: [], headways: [], transfers: list });
  assert.deepEqual(rederiveWalked("subway.json", shard(transfers), graph, WALK_PARAMS), {
    candidates: 2,
    walked: 2,
  });

  const walked = transfers[0] as TransferEdge;
  const tampered = (patch: Partial<TransferEdge>) => shard([{ ...walked, ...patch }]);
  assert.throws(
    () => rederiveWalked("subway.json", tampered({ walkM: (walked.walkM as number) - 20 }), graph, WALK_PARAMS),
    /re-routed/,
  );
  assert.throws(
    () => rederiveWalked("subway.json", tampered({ minSec: walked.minSec - 10 }), graph, WALK_PARAMS),
    /minSec/,
  );
  // Left spatial when the network walks it: a real change the build dropped.
  assert.throws(
    () => rederiveWalked("subway.json", tampered({ kind: "spatial", walkM: undefined }), graph, WALK_PARAMS),
    /published spatial, but walks/,
  );
  // Published walked where the pavement no longer goes.
  const cut = buildFootwayGraph([way(9, [[30, 0], [60, 0]])]);
  assert.throws(() => rederiveWalked("subway.json", shard([walked]), cut, WALK_PARAMS), /re-routing refuses/);
});
