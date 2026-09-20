/**
 * Navigation scale matrix — the search-compute half of the latency-attribution
 * baseline, measured in Node so graph size can sweep while the browser bench
 * (`npm run bench:route`) holds end-to-end wall clock.
 *
 * Deliberately **not** a test. Vitest's benchmark glob stays disjoint from the
 * test glob in `vitest.config.ts`, so nothing here runs under `npm test` or CI:
 *
 *   npm run bench
 *
 * Everything here goes through the public routing surface (`paretoRoutes`,
 * `dijkstra`, `reachableFrom`, `findBestTrainRoute`), on deterministic
 * synthetic builds whose counts the transit fixture test pins. The transit
 * fixtures fold back into the browser benches as the seeded scale dataset, so
 * the two runs describe the same synthetic city. Record results in a dated
 * note beside `docs/notes/performance-baseline.md`.
 */

import { bench, describe } from "vitest";
import { dijkstra, paretoRoutes, reachableFrom, type RoutingGraph } from "../routing";
import {
  findBestTrainRoute,
  nearestStations,
  readHeadway,
  stationServesMode,
  trainDijkstra,
  type TrainDepartureOptions,
  type TrainGraph,
  type TrainStation,
} from "../trainGraph";
import { buildTrainGraphFromShards } from "../transit/trainGraphAdapter";
import {
  parseTransitManifest,
  parseTransitPointer,
  parseTransitShard,
  type TransitManifest,
  type TransitShard,
  type TransitShardRef,
} from "../transit/shardContract";
import {
  buildTransitShardFixture,
  TRANSIT_SCALE_COUNTS,
} from "../../../e2e/fixtures/transitShards";
import { MinHeap } from "../minHeap";

// ─── Walking graphs ─────────────────────────────────────────────────────────

/** Spine rows in Manhattan; meters per degree near the bench grid. */
const DEG_PER_M_LAT = 1 / 110_900;
const DEG_PER_M_LNG = 1 / 84_400;
const ORIGIN: [number, number] = [-74.0, 40.7];

/**
 * A connected rectangular street grid. Every cell pushes both directions of its
 * four neighbours, so the city-size case is one component and `reachableFrom`
 * honestly has to walk all of it. `shadowFactor` cycles through a deterministic
 * pattern — no planner can turn the grid into a constant-cost field.
 */
function streetGrid(rows: number, cols: number): RoutingGraph {
  const nodes: RoutingGraph["nodes"] = new Map();
  const adj: RoutingGraph["adj"] = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      nodes.set(id, {
        id,
        lat: ORIGIN[1] + r * 45 * DEG_PER_M_LAT,
        lon: ORIGIN[0] + c * 45 * DEG_PER_M_LNG,
      });
      adj.set(id, []);
    }
  }
  const factor = (fromId: number, toId: number) => ((fromId * 7 + toId * 13) % 23) / 23;
  const link = (fromId: number, toId: number) => {
    adj.get(fromId)!.push({ toId, distanceM: 45, shadowFactor: factor(fromId, toId) });
    adj.get(toId)!.push({ toId: fromId, distanceM: 45, shadowFactor: factor(toId, fromId) });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      if (c + 1 < cols) link(id, id + 1);
      if (r + 1 < rows) link(id, id + cols);
    }
  }
  return { nodes, adj };
}

/** The two corners of each walk case, and the 5-stop chain for the 12-pass loop. */
function walkFixture(nodes: number) {
  const corners = [0, nodes - 1];
  const via = [
    0,
    Math.floor((nodes - 1) * 0.25),
    Math.floor((nodes - 1) * 0.5),
    Math.floor((nodes - 1) * 0.75),
    nodes - 1,
  ];
  const strengths = [0, 0.5, 1.0];
  return { corners, via, strengths };
}

// ─── Transit graphs from the seeded scale fixture ───────────────────────────

/** Parse the three-hop artifacts through the production parsers — the same
 * bytes the browser bench's stub serves, verified the same way. */
function parseFixture() {
  const artifacts = buildTransitShardFixture({});
  const pointer = parseTransitPointer(JSON.parse(artifacts.pointer));
  const manifest = parseTransitManifest(JSON.parse(artifacts.manifest), pointer.generation);
  const shards: TransitShard[] = [];
  for (const ref of manifest.shards) shards.push(parseOneShard(artifacts, manifest, ref));
  const subwayStops = shards.find((shard) => shard.kind === "subway")?.stops ?? [];
  return { manifest, shards, subwayStops };
}

function parseOneShard(
  artifacts: ReturnType<typeof buildTransitShardFixture>,
  _manifest: TransitManifest,
  ref: TransitShardRef,
): TransitShard {
  const body = artifacts.shards.get(ref.key);
  if (!body) throw new Error(`fixture is missing shard ${ref.key}`);
  return parseTransitShard(JSON.parse(body), ref);
}

const fixture = parseFixture();

function trainGraphs() {
  const { manifest, shards } = fixture;
  const subway = shards.filter((shard) => shard.kind === "subway");
  const bus = shards.filter((shard) => shard.kind === "bus-shard");
  const build = (slice: TransitShard[]) => {
    const graph = buildTrainGraphFromShards(slice, manifest.headwayDates);
    if (!graph) throw new Error("fixture built no train graph");
    return graph;
  };
  return { subway: build(subway), bus: build(bus), combined: build(shards) };
}

const train = trainGraphs();

// The browser bench's TRANSIT_WAYPOINT pair: opposite corners of the grid,
// ~950 m apart. Local copy so this file does not import the e2e helper.
const GRID_A: [number, number] = [-73.9871, 40.7518];
const GRID_B: [number, number] = [-73.9809, 40.7562];
// SHARE_URL pins 2026-06-21 at 09:00 in America/New_York — a Sunday.
const DEPARTURE: TrainDepartureOptions = {
  at: new Date("2026-06-21T13:00:00Z"),
  utcOffsetMin: -240,
};

// The city-crossing trip the scale rows measure: outer-borough anchors on the
// synthetic E chain (~33 km east and west of the grid), so each pair-wise
// search explores hundreds of (station, line) states instead of a handful of
// chain neighbours. Indexed off the fixture's own typed stops, not re-derived.
const WEST_ANCHOR: [number, number] = [fixture.subwayStops[60].lon, fixture.subwayStops[60].lat];
const EAST_ANCHOR: [number, number] = [fixture.subwayStops[446].lon, fixture.subwayStops[446].lat];

/**
 * The pair-wise baseline: one `trainDijkstra` per (entry, exit) candidate pair,
 * exactly what `findBestTrainRoute` runs today (5 × 5 = 25 searches).
 */
function pairwiseSearches(graph: TrainGraph, mode: "subway" | "bus"): number {
  const accept = (station: TrainStation) => stationServesMode(graph, station, mode);
  const entries = nearestStations(WEST_ANCHOR, graph.stations, 5, 1500, accept);
  const exits = nearestStations(EAST_ANCHOR, graph.stations, 5, 1500, accept);
  let best = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    for (const exit of exits) {
      if (entry.id === exit.id) continue;
      const path = trainDijkstra(graph, entry.id, exit.id, DEPARTURE);
      if (path && path.stationIds.length >= 3) best = Math.min(best, path.totalSec);
    }
  }
  return best;
}

/**
 * The proposed fix, replicated locally in this spec: one search per entry that
 * settles every exit at once. Same states, same pricing (`readHeadway` is the
 * production reader), so the comparison is search organisation only.
 */
function oneToManySearches(graph: TrainGraph, mode: "subway" | "bus"): number {
  const accept = (station: TrainStation) => stationServesMode(graph, station, mode);
  const entries = nearestStations(WEST_ANCHOR, graph.stations, 5, 1500, accept);
  const exits = new Set(
    nearestStations(EAST_ANCHOR, graph.stations, 5, 1500, accept).map((ex) => ex.id),
  );

  const SEP = "\u0000";
  const FOOT = "";
  const TRANSFER = "\u0001";
  const stateKey = (stationId: string, arrivedOn: string) => `${stationId}${SEP}${arrivedOn}`;
  const stationOf = (key: string) => key.slice(0, key.indexOf(SEP));
  const arrivalOf = (key: string) => key.slice(key.indexOf(SEP) + 1);

  let best = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    if (exits.has(entry.id)) continue;
    const dist = new Map<string, number>();
    const pq = new MinHeap<{ key: string; cost: number; seq: number }>(
      (x, y) => x.cost - y.cost || x.seq - y.seq,
    );
    let seq = 0;
    const startKey = stateKey(entry.id, FOOT);
    dist.set(startKey, 0);
    pq.push({ key: startKey, cost: 0, seq: seq++ });

    const settledExits = new Set<string>();
    while (pq.size > 0) {
      const { key, cost } = pq.pop()!;
      if (cost > (dist.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      const id = stationOf(key);
      if (exits.has(id)) {
        // States pop in cost order, so the first state settled at an exit is
        // the cheapest way to stand there, exactly as the shipped search
        // prices its single destination.
        best = Math.min(best, cost);
        settledExits.add(id);
        if (settledExits.size === exits.size) break;
      }
      const arrivedOn = arrivalOf(key);
      for (const edge of graph.adj.get(id) ?? []) {
        if (edge.type !== "rail") {
          const walkCost = cost + edge.weightSec;
          const nextKey = stateKey(edge.to, TRANSFER);
          if (walkCost < (dist.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
            dist.set(nextKey, walkCost);
            pq.push({ key: nextKey, cost: walkCost, seq: seq++ });
          }
          continue;
        }
        const route = edge.line ?? "";
        if (arrivedOn === route) {
          const rideCost = cost + edge.weightSec;
          const nextKey = stateKey(edge.to, route);
          if (rideCost < (dist.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
            dist.set(nextKey, rideCost);
            pq.push({ key: nextKey, cost: rideCost, seq: seq++ });
          }
          continue;
        }
        const changing = arrivedOn !== FOOT && arrivedOn !== TRANSFER;
        const changeSec = changing ? (graph.stations.get(id)?.changeSec ?? 0) : 0;
        const reading = readHeadway(
          graph.headways,
          route,
          edge.direction,
          DEPARTURE.at!,
          DEPARTURE.utcOffsetMin!,
        );
        if (reading.kind === "no-service") continue;
        const waitSec = reading.kind === "published" ? reading.medianSec / 2 : 0;
        const boardCost = cost + edge.weightSec + changeSec + waitSec;
        const nextKey = stateKey(edge.to, route);
        if (boardCost < (dist.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
          dist.set(nextKey, boardCost);
          pq.push({ key: nextKey, cost: boardCost, seq: seq++ });
        }
      }
    }
  }

  return best;
}

// ─── Cases ───────────────────────────────────────────────────────────────────

const walkSizes = [
  { label: "121 nodes (11×11)", rows: 11, cols: 11 },
  { label: "4,600 nodes (92×50)", rows: 92, cols: 50 },
  { label: "16,800 nodes (140×120)", rows: 140, cols: 120 },
] as const;

// Both organisations must price the same trip identically; the benchmark only
// compares their clocks, never their answers.
{
  const pairWise = pairwiseSearches(train.subway, "subway");
  const oneToMany = oneToManySearches(train.subway, "subway");
  if (!Number.isFinite(pairWise) || !Number.isFinite(oneToMany)) {
    throw new Error(
      `train search self-check found no city-crossing answer (${pairWise}, ${oneToMany})`,
    );
  }
  if (Math.abs(pairWise - oneToMany) > 1e-9) {
    throw new Error(
      `one-to-many replication prices the trip differently: ${oneToMany.toFixed(3)} vs pair-wise ${pairWise.toFixed(3)}`,
    );
  }
}

const heavy = { time: 0, iterations: 5, warmupIterations: 1 } as const;
const light = { time: 0, iterations: 20, warmupIterations: 2 } as const;

describe("walk search — paretoRoutes, 2-point", () => {
  for (const size of walkSizes) {
    const graph = streetGrid(size.rows, size.cols);
    const { corners } = walkFixture(size.rows * size.cols);
    bench(
      size.label,
      () => {
        paretoRoutes(graph, corners[0], corners[1]);
      },
      heavy,
    );
  }
});

describe("walk search — per-leg 12-pass loop (5-stop shape × 3 strengths)", () => {
  for (const size of walkSizes) {
    const graph = streetGrid(size.rows, size.cols);
    const { via, strengths } = walkFixture(size.rows * size.cols);
    bench(
      size.label,
      () => {
        for (const strength of strengths) {
          for (let leg = 0; leg + 1 < via.length; leg++) {
            dijkstra(graph, via[leg], via[leg + 1], strength);
          }
        }
      },
      heavy,
    );
  }
});

// ─── A3: paretoRoutes city-scale budget curve ────────────────────────────────
//
// Session A3 of `docs/handoffs/LATENCY_ATTRIBUTION_SESSIONS.md`. The committed
// trigger (`docs/notes/navigation-latency-attribution-2026-09-19.md`): 484.3 ms
// at 4,600 nodes and 2,434.6 ms at 16,800 nodes, against a 16.8 k < 300 ms gate.
// The bi-criteria search is superlinear in graph size, and this is the one fix
// that trades route diversity for speed — so per the handoff it is measured
// first and retuned later, never guessed at.
//
// This sweep prices every (maxDetourFactor × maxLabelsPerNode) operating point
// at both city sizes: the `bench()` rows below report mean search time, and the
// KPI pass reports the shadow-gain / length-overhead pair the same way
// `computeDerivedKpis` prices returned routes (shortest vs most shadowed). The
// synthetic grid's deterministic `shadowFactor` pattern makes that pair
// meaningful; `e2e/bench/detourSweep.bench.spec.ts` is the earlier precedent for
// reading such a curve.
//
// PR 1 is measurement-only: `paretoRoutes`'s defaults stay 2.0/20
// (`maxLabelsPerNode` is a default-20 knob no production caller passes), so
// routing behavior is byte-identical to `main` — `routing.test.ts` proves it.

const sweepFactors = [1.1, 1.25, 1.5, 2.0, 2.5, 3.0] as const;
const sweepCaps = [5, 10, 20] as const;
/** The two city-scale sizes from the committed trigger row. */
const sweepSizes = [walkSizes[1], walkSizes[2]] as const;

// Degeneracy guard: a sweep over a field that is all sun or all shadow prices
// nothing (every budget ties). Fail loudly instead of publishing a flat curve.
const sweepShadowFactors: number[] = [];
for (const [, edges] of streetGrid(140, 120).adj) {
  for (const edge of edges) sweepShadowFactors.push(edge.shadowFactor);
}
const sweepShadowMean =
  sweepShadowFactors.reduce((a, b) => a + b, 0) / sweepShadowFactors.length;
if (sweepShadowMean <= 0.05 || sweepShadowMean >= 0.95) {
  throw new Error(
    `sweep fixture shadow is degenerate (${sweepShadowMean.toFixed(3)}) — every budget would tie`,
  );
}

interface SweepKpiRow {
  size: (typeof sweepSizes)[number];
  factor: number;
  cap: number;
  routeCount: number;
  /** Shortest vs most-shadowed, `computeDerivedKpis` style. */
  shadowGainPp: number | null;
  lengthOverheadPct: number | null;
}

/**
 * O-D pairs per size, proportional to the grid (the detourSweep precedent
 * spreads pairs so one easy pair cannot carry the average): opposite corners —
 * the committed scale-case pair — plus a city diagonal, a full row and a full
 * column. Same shape at both sizes.
 */
function sweepPairs(rows: number, cols: number): Array<[number, number]> {
  const lastR = rows - 1;
  const lastC = cols - 1;
  return [
    [0, 0],
    [lastR, lastC],
    [Math.floor(rows * 0.25), 0],
    [Math.floor(rows * 0.75), lastC],
    [Math.floor(rows * 0.5), 0],
    [Math.floor(rows * 0.5), lastC],
    [0, Math.floor(cols * 0.5)],
    [lastR, Math.floor(cols * 0.5)],
  ];
}

/** Row/col → node id (the grid indexes row-major). */
const sweepNodeId = (cols: number, r: number, c: number) => r * cols + c;

/**
 * Deterministic (single-run) KPI pass over the whole sweep: `sweepPairs` per
 * size, returned routes priced exactly like `computeDerivedKpis` (shortest
 * first, most shadowed last), averaged over the pairs. Single runs per pair
 * are enough — the grid and the search are deterministic.
 */
function sweepKpis(): SweepKpiRow[] {
  const rows: SweepKpiRow[] = [];
  for (const size of sweepSizes) {
    const graph = streetGrid(size.rows, size.cols);
    const pairs = sweepPairs(size.rows, size.cols);
    for (const cap of sweepCaps) {
      for (const factor of sweepFactors) {
        let routeTotal = 0;
        let gainTotal = 0;
        let gainRuns = 0;
        let overheadTotal = 0;
        let overheadRuns = 0;
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          const startId = sweepNodeId(size.cols, pairs[i][0], pairs[i][1]);
          const endId = sweepNodeId(size.cols, pairs[i + 1][0], pairs[i + 1][1]);
          const routes = paretoRoutes(graph, startId, endId, {
            maxDetourFactor: factor,
            maxLabelsPerNode: cap,
          });
          routeTotal += routes.length;
          if (routes.length >= 2 && routes[0].distanceM > 0) {
            gainTotal +=
              (routes[routes.length - 1].shadowCoverage - routes[0].shadowCoverage) *
              100;
            overheadTotal +=
              ((routes[routes.length - 1].distanceM - routes[0].distanceM) /
                routes[0].distanceM) *
              100;
            gainRuns++;
            overheadRuns++;
          }
        }
        const pairCount = pairs.length / 2;
        rows.push({
          size,
          factor,
          cap,
          routeCount: routeTotal / pairCount,
          shadowGainPp: gainRuns > 0 ? gainTotal / gainRuns : null,
          lengthOverheadPct:
            overheadRuns > 0 ? overheadTotal / overheadRuns : null,
        });
      }
    }
  }
  return rows;
}

/** The one point the PR 2 decision compares against: today's 2.0/20 defaults. */
function fmtKpiRow(size: (typeof sweepSizes)[number], row: SweepKpiRow): string {
  const gain = row.shadowGainPp === null ? "—" : `${row.shadowGainPp.toFixed(2)} pp`;
  const overhead =
    row.lengthOverheadPct === null ? "—" : `+${row.lengthOverheadPct.toFixed(1)}%`;
  return [
    size.label,
    row.factor.toFixed(2),
    String(row.cap),
    String(row.routeCount),
    gain,
    overhead,
  ].join(" | ");
}

/** Per-pair detail at the default budget, for auditing the means. */
function sweepKpiPairDetail(): string[] {
  const lines: string[] = [];
  for (const size of sweepSizes) {
    const graph = streetGrid(size.rows, size.cols);
    const pairs = sweepPairs(size.rows, size.cols);
    const labels = [
      "opposite corners (scale case)",
      "city diagonal",
      "full row",
      "full column",
    ];
    for (const cap of sweepCaps) {
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const startId = sweepNodeId(size.cols, pairs[i][0], pairs[i][1]);
        const endId = sweepNodeId(size.cols, pairs[i + 1][0], pairs[i + 1][1]);
        const routes = paretoRoutes(graph, startId, endId, {
          maxDetourFactor: 2.0,
          maxLabelsPerNode: cap,
        });
        const gain =
          routes.length >= 2 && routes[0].distanceM > 0
            ? ((routes[routes.length - 1].shadowCoverage -
                routes[0].shadowCoverage) *
                100
              ).toFixed(2)
            : "—";
        const overhead =
          routes.length >= 2 && routes[0].distanceM > 0
            ? ((routes[routes.length - 1].distanceM - routes[0].distanceM) /
                routes[0].distanceM) *
              100
            : 0;
        lines.push(
          [
            size.label,
            String(cap),
            labels[i / 2],
            `${gain} pp`,
            `+${overhead.toFixed(1)}%`,
          ].join(" | "),
        );
      }
    }
  }
  return lines;
}

// Printed at collection time so every run of this file publishes the curve's
// quality half alongside the vitest-reported mean search times. Mean over
// `sweepPairs` (4 pairs per size, opposite corners among them).
console.log(
  `\n### A3 budget sweep — route quality (deterministic, mean of ${sweepPairs(10, 10).length / 2} O-D pairs per size)\n\n` +
    `${sweepSizes
      .map((s) => s.label)
      .join(" / ")} grids, shadow-gain and length-overhead priced \`computeDerivedKpis\`-style ` +
    `(shortest vs most shadowed). Mean grid shadowFactor ${sweepShadowMean.toFixed(3)}.\n\n` +
    `| size | maxDetourFactor | maxLabelsPerNode | routes | shadow gain | length overhead |\n` +
    `|---|---:|---:|---:|---:|---:|\n` +
    sweepKpis()
      .map((row) => `| ${fmtKpiRow(row.size, row)} |`)
      .join("\n") +
    `\n\nPer-pair rows for the default budget (maxDetourFactor 2.0), so the ` +
    `mean table is auditable pair by pair:\n\n` +
    `| size | maxLabelsPerNode | pair | shadow gain | length overhead |\n` +
    `|---|---:|---:|---:|---:|\n` +
    sweepKpiPairDetail()
      .map((line) => `| ${line} |`)
      .join("\n") +
    `\n`,
);

describe("walk search — paretoRoutes budget sweep (A3 curve)", () => {
  for (const size of sweepSizes) {
    const graph = streetGrid(size.rows, size.cols);
    const nodes = size.rows * size.cols;
    for (const cap of sweepCaps) {
      for (const factor of sweepFactors) {
        bench(
          `${size.label} · detour ${factor.toFixed(2)} × labels ${cap}`,
          () => {
            paretoRoutes(graph, 0, nodes - 1, {
              maxDetourFactor: factor,
              maxLabelsPerNode: cap,
            });
          },
          // The 16.8 k rows are the expensive half of the curve (up to ~3 s
          // per run at 3.0/20): fewer samples, same warmup, ±3% stability.
          size.rows === 92
            ? { time: 0, iterations: 5, warmupIterations: 1 }
            : { time: 0, iterations: 3, warmupIterations: 1 },
        );
      }
    }
  }
});

describe("walk reachability — reachableFrom, city-size", () => {
  const graph = streetGrid(140, 120);
  bench(
    "16,800 nodes, whole grid reachable",
    () => {
      reachableFrom(graph, 0);
    },
    light,
  );
});

const trainCases = [
  {
    label: `subway, city-crossing (${TRANSIT_SCALE_COUNTS.subwayStations} stations, ${TRANSIT_SCALE_COUNTS.trainStates} states)`,
    graph: train.subway,
    modes: ["subway"] as const,
    from: WEST_ANCHOR,
    to: EAST_ANCHOR,
  },
  {
    label: `bus, far from any selected corridor (${TRANSIT_SCALE_COUNTS.busStops} stops, null answer)`,
    graph: train.bus,
    modes: ["bus"] as const,
    from: WEST_ANCHOR,
    to: EAST_ANCHOR,
  },
  {
    label: `bus corridor answer (${TRANSIT_SCALE_COUNTS.busStops} stops in graph, 12 stops serve the pair)`,
    graph: train.bus,
    modes: ["bus"] as const,
    from: GRID_A,
    to: GRID_B,
  },
  {
    label: `combined (${TRANSIT_SCALE_COUNTS.subwayStations + TRANSIT_SCALE_COUNTS.busStops} stations, both modes)`,
    graph: train.combined,
    modes: ["subway", "bus"] as const,
    from: WEST_ANCHOR,
    to: EAST_ANCHOR,
  },
] as const;

describe("train search — findBestTrainRoute", () => {
  for (const topic of trainCases) {
    bench(
      topic.label,
      () => {
        for (const mode of topic.modes) {
          findBestTrainRoute(topic.from, topic.to, topic.graph, 1500, 5, DEPARTURE, mode);
        }
      },
      heavy,
    );
  }
});

describe("train search — 25 pair-wise vs one-entry-per-search, city-crossing", () => {
  bench(
    "pair-wise (25 trainDijkstra runs, as shipped)",
    () => {
      pairwiseSearches(train.subway, "subway");
    },
    { time: 0, iterations: 20, warmupIterations: 2 },
  );

  bench(
    "one-to-many (one search per entry, replicated locally)",
    () => {
      oneToManySearches(train.subway, "subway");
    },
    { time: 0, iterations: 20, warmupIterations: 2 },
  );
});
