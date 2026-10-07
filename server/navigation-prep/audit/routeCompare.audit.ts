/**
 * Route-search comparison on real data — run by hand, like `shadeAudit`:
 *
 *   NAVIGATION_PREP_ROOT=… SHADE_AUDIT_GENERATION=nyc-… \
 *   npm --prefix server/navigation-prep run audit:shade -- routeCompare
 *
 * Each route is built the way `useRouting` builds it, so the search sees the
 * app's graph, not a smaller one: the static selection with the transit access
 * zones (2 km around each endpoint), sidewalk edges priced from the published
 * shade table at the app's own bucket count, and stops snapped with
 * `snapRouteStopsToReachableEdges`. `paretoRoutes` at the shipped cap (20) is
 * the reference; its `searchStrategy: "direct"` (L4) is held to it — same shortest, same least-sun
 * route, a close balanced one — and timed on the same graph.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildRoutingGraphFromStreetShards } from "../../../app/lib/navigationData/routingGraphAdapter";
import { routingEdgeBatch } from "../../../app/lib/navigationHelpers";
import { createShadeTableView, shadeSlotsForDeparture } from "../../../app/lib/navigationData/shadeTable";
import {
  parseNavigationManifest,
  parseNavigationShadeShard,
  parseNavigationStreetShard,
} from "../../../app/lib/navigationData/shardContract";
import { selectNavigationShardsForBoxes, zoneAround } from "../../../app/lib/navigationData/remoteNavigation";
import { TRANSIT_ACCESS_RADIUS_M } from "../../../app/lib/navigationData/routingGraphSource";
import { SHADE_ZONE, shadeSlotByteLength, shadeSlotByteOffset } from "../../../app/lib/navigationData/shadeSlots";
import { utcOffsetMinAt } from "../../../app/lib/timezone";
import { edgeTraversalSeconds, travelTimeSeconds } from "../../../app/lib/travelMode";
import { computeSolarIntensity } from "../../../app/lib/shadowSampling";
import {
  DEFAULT_MAX_DETOUR_FACTOR,
  DETOUR_FLAT_M,
  type GraphEdge,
  haversineMeters,
  paretoRoutes,
  parallelSidewalkEdges,
  type RouteResult,
  type RoutingGraph,
  snapRouteStopsToReachableEdges,
} from "../../../app/lib/routing";

const root = process.env.NAVIGATION_PREP_ROOT!;
const gen = process.env.SHADE_AUDIT_GENERATION!;
const dir = join(root, "normalized", gen, "navigation", "nyc", gen);
const only = process.env.ROUTES?.split(",");

/** Local times are New York; `at` is the UTC instant. */
const ROUTES: Array<{ name: string; a: [number, number]; b: [number, number]; at: string }> = [
  { name: "LES→Kips Bay 12:43", a: [-73.99338, 40.72908], b: [-73.95415, 40.74305], at: "2026-10-01T16:43:00Z" },
  { name: "UES→Murray Hill 16:03", a: [-73.95518, 40.77428], b: [-73.95056, 40.74486], at: "2026-10-06T20:03:00Z" },
  { name: "UWS→FiDi 15:12", a: [-73.9807, 40.78016], b: [-74.0131, 40.72947], at: "2026-10-05T19:12:00Z" },
  { name: "Chelsea→Union Sq 10:00", a: [-74.0005, 40.7465], b: [-73.9903, 40.7359], at: "2026-07-15T14:00:00Z" },
  { name: "Harlem→UWS 08:30", a: [-73.9442, 40.8116], b: [-73.9712, 40.7870], at: "2026-06-20T12:30:00Z" },
  { name: "Park Slope→Bklyn Hts 14:00", a: [-73.9776, 40.6710], b: [-73.9937, 40.6955], at: "2026-08-10T18:00:00Z" },
  { name: "Williamsburg→Greenpoint 17:30", a: [-73.9573, 40.7140], b: [-73.9510, 40.7300], at: "2026-05-12T21:30:00Z" },
  { name: "Astoria→LIC 11:15", a: [-73.9230, 40.7644], b: [-73.9442, 40.7447], at: "2026-09-02T15:15:00Z" },
  { name: "Midtown→Central Park 13:00", a: [-73.9855, 40.7580], b: [-73.9665, 40.7812], at: "2026-07-01T17:00:00Z" },
  { name: "FiDi→Chinatown 09:00", a: [-74.0090, 40.7075], b: [-73.9975, 40.7158], at: "2026-04-15T13:00:00Z" },
  { name: "Bed-Stuy→Crown Hts 15:45", a: [-73.9442, 40.6872], b: [-73.9442, 40.6694], at: "2026-08-25T19:45:00Z" },
  { name: "Inwood→Washington Hts 12:00", a: [-73.9215, 40.8677], b: [-73.9385, 40.8448], at: "2026-06-05T16:00:00Z" },
];

interface RouteCase {
  name: string;
  graph: RoutingGraph;
  startId: number;
  endId: number;
  options: Parameters<typeof paretoRoutes>[3];
  nodes: number;
}

/** Builds one route exactly as `useRouting` does (minus the network). */
async function buildCase(route: (typeof ROUTES)[number]): Promise<RouteCase> {
  const manifest = parseNavigationManifest(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")), gen);
  const straightLineDistM = haversineMeters(route.a, route.b);
  const padding = Math.max(0.005, Math.min(0.008, (straightLineDistM / 111000) * 0.3));
  const box = {
    south: Math.min(route.a[1], route.b[1]) - padding,
    north: Math.max(route.a[1], route.b[1]) + padding,
    west: Math.min(route.a[0], route.b[0]) - padding,
    east: Math.max(route.a[0], route.b[0]) + padding,
  };
  const zones = straightLineDistM > 500
    ? [zoneAround(route.a[0], route.a[1], TRANSIT_ACCESS_RADIUS_M), zoneAround(route.b[0], route.b[1], TRANSIT_ACCESS_RADIUS_M)]
    : [];
  const selection = selectNavigationShardsForBoxes(manifest, box, zones)!;
  const streets = await Promise.all(selection.streets.map(async (ref) =>
    parseNavigationStreetShard(JSON.parse(await readFile(join(dir, ref.key), "utf8")), ref, gen)));
  const graph = buildRoutingGraphFromStreetShards(streets);

  // The app's bucket count: the walk horizon at the detour budget, 15-minute buckets, ≤ 8.
  const departure = new Date(route.at);
  const horizonSec = travelTimeSeconds(straightLineDistM * DEFAULT_MAX_DETOUR_FACTOR + DETOUR_FLAT_M, "walk");
  const bucketCount = Math.max(1, Math.min(8, Math.ceil((horizonSec * 1000) / (15 * 60_000))));
  const { perBucket, slotIndices } = shadeSlotsForDeparture(departure, bucketCount, utcOffsetMinAt(SHADE_ZONE, departure));
  // The shade selection covers the same cover box the app uses (primary ∪ zones).
  const cover = [box, ...zones].reduce((u, z) => ({
    south: Math.min(u.south, z.south), north: Math.max(u.north, z.north),
    west: Math.min(u.west, z.west), east: Math.max(u.east, z.east),
  }));
  const shadeRefs = (manifest.shadeShards ?? []).filter((ref) =>
    ref.geometryBounds.west <= cover.east && ref.geometryBounds.east >= cover.west
    && ref.geometryBounds.south <= cover.north && ref.geometryBounds.north >= cover.south);
  const view = createShadeTableView(await Promise.all(shadeRefs.map(async (ref) => {
    const shard = parseNavigationShadeShard(JSON.parse(await readFile(join(dir, ref.key), "utf8")), ref, gen);
    const payload = await readFile(join(dir, ref.payloadKey));
    const n = shard.segments.length;
    const blocks = new Map<number, Uint8Array>();
    for (const s of slotIndices) {
      const start = shadeSlotByteOffset(s, n);
      blocks.set(s, new Uint8Array(payload.subarray(start, start + shadeSlotByteLength(n))));
    }
    return { shard, blocks };
  })));

  const table = new Map<string, { left: number[]; right: number[] }>();
  for (const key of routingEdgeBatch(graph).keys) {
    const left: number[] = [];
    const right: number[] = [];
    for (const slot of perBucket) {
      const v = view.shadowFor(key, slot);
      left.push(v?.left ?? 0);
      right.push(v?.right ?? 0);
    }
    table.set(key, { left, right });
  }
  const adj = new Map<number, GraphEdge[]>();
  for (const [fromId, edges] of graph.adj) {
    if (!adj.has(fromId)) adj.set(fromId, []);
    for (const edge of edges) {
      const lo = Math.min(fromId, edge.toId);
      const hi = Math.max(fromId, edge.toId);
      const t = table.get(`${lo},${hi}`)!;
      const canonical = fromId < edge.toId;
      adj.get(fromId)!.push(...parallelSidewalkEdges(fromId, edge, t.left[0], t.right[0]).map((s) => ({
        ...s,
        timeShadow: s.side === "left" ? (canonical ? t.left : t.right) : (canonical ? t.right : t.left),
      })));
    }
  }
  const routingGraph: RoutingGraph = { nodes: graph.nodes, adj };
  const snapped = snapRouteStopsToReachableEdges([route.a, route.b], routingGraph, { maxSnapDistanceM: 100 });
  const midLat = (route.a[1] + route.b[1]) / 2;
  const midLng = (route.a[0] + route.b[0]) / 2;
  return {
    name: route.name,
    graph: routingGraph,
    startId: snapped.ids[0],
    endId: snapped.ids[1],
    nodes: graph.nodes.size,
    options: {
      crossingPenaltyM: 15,
      solarIntensity: computeSolarIntensity(departure, midLat, midLng),
      straightLineDistM,
      travelMode: "walk",
      objective: "sun",
      timeAware: { bucketMs: 15 * 60_000, bucketCount },
    },
  };
}

/** Sun seconds on the route — the criterion the search minimises (H2). */
const sunOf = (r: RouteResult) => r.exposure?.exposedDurationSec ?? Number.POSITIVE_INFINITY;
/**
 * Sun seconds along a returned path, re-priced independently of the search:
 * walk its nodes, take the cheapest-exposure sidewalk edge between each pair
 * at the arrival clock, and sum traversal × (1 − shadow). A search that
 * mis-accounts its own criterion shows up as a gap against `sunOf`.
 */
function reprice(c: RouteCase, r: RouteResult): number {
  const bucketMs = c.options!.timeAware!.bucketMs;
  const buckets = c.options!.timeAware!.bucketCount;
  let clock = 0;
  let sun = 0;
  for (let i = 0; i + 1 < r.nodeIds.length; i++) {
    const side = r.sides?.[i] ?? null;
    const edges = (c.graph.adj.get(r.nodeIds[i]) ?? []).filter((e) => e.toId === r.nodeIds[i + 1] && (side == null || e.side === side));
    const edge = edges[0];
    if (!edge) return Number.NaN;
    const sec = edgeTraversalSeconds(edge, "walk");
    clock += sec;
    const b = Math.min(Math.floor((clock * 1000) / bucketMs), buckets - 1);
    const shade = edge.timeShadow?.[Math.min(b, (edge.timeShadow?.length ?? 1) - 1)] ?? edge.shadowFactor;
    sun += sec * (1 - shade);
  }
  return sun;
}

const describeRoute = (r: RouteResult) => `${(r.distanceM / 1000).toFixed(2)}km/${Math.round(r.shadowCoverage * 100)}%`;
const keyOf = (r: RouteResult) => r.nodeIds.join(",");

it("route search comparison", { timeout: 6 * 3600_000 }, async () => {
  const failures: string[] = [];
  for (const route of ROUTES) {
    if (only && !only.some((name) => route.name.startsWith(name))) continue;
    let c: RouteCase;
    try {
      c = await buildCase(route);
    } catch (error) {
      // Unroutable in production too (e.g. #305) — not a search question.
      process.stderr.write(`${route.name.padEnd(32)} SKIPPED: ${(error as Error).message.slice(0, 90)}\n`);
      continue;
    }
    let t = performance.now();
    const reference = paretoRoutes(c.graph, c.startId, c.endId, c.options);
    const referenceMs = performance.now() - t;
    t = performance.now();
    const direct = paretoRoutes(c.graph, c.startId, c.endId, { ...c.options, searchStrategy: "direct" });
    const directMs = performance.now() - t;

    // Representatives by role. The reference returns [shortest, knee, extreme]
    // deduped; roles are recovered from the metrics, not from positions.
    const leastSunOf = (rs: RouteResult[]) => rs.reduce((x, y) => (sunOf(y) < sunOf(x) ? y : x));
    // Both strategies return the *cost*-shortest (mode metres + crossing
    // penalties) first; a physically shorter route with more crossings is a
    // different, legitimate option, so compare the first results.
    const refShort = reference[0];
    const refLeast = leastSunOf(reference);
    const dirShort = direct[0];
    const dirLeast = leastSunOf(direct);
    // Equal mode-cost lengths are a tie the two searches may break differently.
    const sameShortest = keyOf(refShort) === keyOf(dirShort)
      || Math.abs(refShort.distanceM - dirShort.distanceM) < 0.5;
    // Least-sun: same route, or no worse on sun within the same budget.
    const leastSunOk = keyOf(refLeast) === keyOf(dirLeast) || sunOf(dirLeast) <= sunOf(refLeast) + 1e-6;
    process.stderr.write(
      `${c.name.padEnd(32)} nodes ${String(c.nodes).padStart(6)} | ref ${String(Math.round(referenceMs)).padStart(6)} ms ` +
      `${reference.map(describeRoute).join(" ")} | direct ${String(Math.round(directMs)).padStart(5)} ms ` +
      `${direct.map(describeRoute).join(" ")} | shortest ${sameShortest ? "same" : "DIFF"} ` +
      `| least-sun ${keyOf(refLeast) === keyOf(dirLeast) ? "same" : leastSunOk ? "no worse" : "WORSE"} ` +
      `(ref ${Math.round(sunOf(refLeast))} s, direct ${Math.round(sunOf(dirLeast))} s) ` +
      `| shortest m ${refShort.distanceM.toFixed(1)} vs ${dirShort.distanceM.toFixed(1)} ` +
      `| re-priced least-sun ${Math.round(reprice(c, dirLeast))} s\n`,
    );
    // Nothing the reference found may beat a direct route on both counts —
    // shorter (mode cost) AND less sun. If one did, the direct front lost it.
    // The first route is the cost-shortest, identical in both (checked
    // above); physical metres cannot rank it against a route with fewer
    // crossings, so only the trade-off routes are held to this.
    const dominated = direct.slice(1).filter((d) => reference.some((r) =>
      r.distanceM < d.distanceM - 0.5 && sunOf(r) < sunOf(d) - 1e-6));
    if (dominated.length > 0) {
      failures.push(`${c.name}: reference dominates ${dominated.map(describeRoute).join(", ")}`);
    }
    if (!sameShortest) failures.push(`${c.name}: shortest differs`);
    if (!leastSunOk) failures.push(`${c.name}: least-sun route worse`);
  }
  expect(failures).toEqual([]);
});
