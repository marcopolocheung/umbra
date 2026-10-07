/**
 * Offline route replay against a built shade generation (#294) — run by hand,
 * like `shadeAudit.audit.ts`. Rebuilds a route's static street graph from the
 * generation's own shards, prices every edge's H1 buckets from its shade table
 * exactly as `useRouting` does (canonical keys, `parallelSidewalkEdges`, the
 * canonical-side flip), and reports the Pareto routes' shadow coverage.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";
import { buildRoutingGraphFromStreetShards } from "../../../app/lib/navigationData/routingGraphAdapter";
import { routingEdgeBatch } from "../../../app/lib/navigationHelpers";
import { createShadeTableView, shadeSlotsForDeparture } from "../../../app/lib/navigationData/shadeTable";
import {
  parseNavigationManifest,
  parseNavigationShadeShard,
  parseNavigationStreetShard,
  type GeoBounds,
} from "../../../app/lib/navigationData/shardContract";
import { selectNavigationShards } from "../../../app/lib/navigationData/remoteNavigation";
import { SHADE_ZONE, shadeSlotByteLength, shadeSlotByteOffset } from "../../../app/lib/navigationData/shadeSlots";
import { utcOffsetMinAt } from "../../../app/lib/timezone";
import {
  type GraphEdge,
  paretoRoutes,
  parallelSidewalkEdges,
  type RoutingGraph,
  snapToGraph,
} from "../../../app/lib/routing";

const root = process.env.NAVIGATION_PREP_ROOT!;
const generation = process.env.SHADE_AUDIT_GENERATION!;
const dir = join(root, "normalized", generation, "navigation", "nyc", generation);

const ROUTES: Array<{ name: string; a: [number, number]; b: [number, number]; at: string }> = [
  { name: "UES → Murray Hill 16:03", a: [-73.95518, 40.77428], b: [-73.95056, 40.74486], at: "2026-10-06T20:03:00Z" },
  { name: "UWS → FiDi 15:12 (#286)", a: [-73.9807, 40.78016], b: [-74.0131, 40.72947], at: "2026-10-05T19:12:00Z" },
];

describe("route replay", () => {
  it("prices routes from the table", { timeout: 3600_000 }, async () => {
    const manifest = parseNavigationManifest(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")), generation);
    for (const route of ROUTES) {
      const pad = 0.008;
      const box: GeoBounds = {
        south: Math.min(route.a[1], route.b[1]) - pad, north: Math.max(route.a[1], route.b[1]) + pad,
        west: Math.min(route.a[0], route.b[0]) - pad, east: Math.max(route.a[0], route.b[0]) + pad,
      };
      const selection = selectNavigationShards(manifest, box)!;
      const streets = await Promise.all(selection.streets.map(async (ref) =>
        parseNavigationStreetShard(JSON.parse(await readFile(join(dir, ref.key), "utf8")), ref, generation)));
      const graph = buildRoutingGraphFromStreetShards(streets);
      const departure = new Date(route.at);
      const { perBucket, slotIndices } = shadeSlotsForDeparture(departure, 8, utcOffsetMinAt(SHADE_ZONE, departure));
      const tables = await Promise.all(selection.shadeShards.map(async (ref) => {
        const shard = parseNavigationShadeShard(JSON.parse(await readFile(join(dir, ref.key), "utf8")), ref, generation);
        const payload = await readFile(join(dir, ref.payloadKey));
        const n = shard.segments.length;
        const blocks = new Map<number, Uint8Array>();
        for (const s of slotIndices) {
          const start = shadeSlotByteOffset(s, n);
          blocks.set(s, new Uint8Array(payload.subarray(start, start + shadeSlotByteLength(n))));
        }
        return { shard, blocks };
      }));
      const view = createShadeTableView(tables);
      const { keys } = routingEdgeBatch(graph);
      const missing = keys.filter((k) => !view.covers(k)).length;
      const ts = new Map<string, { left: number[]; right: number[] }>();
      for (const key of keys) {
        const left: number[] = [];
        const right: number[] = [];
        for (const slot of perBucket) {
          const v = view.shadowFor(key, slot);
          left.push(v?.left ?? 0);
          right.push(v?.right ?? 0);
        }
        ts.set(key, { left, right });
      }
      const adj = new Map<number, GraphEdge[]>();
      for (const [fromId, edges] of graph.adj) {
        if (!adj.has(fromId)) adj.set(fromId, []);
        for (const edge of edges) {
          const lo = Math.min(fromId, edge.toId);
          const hi = Math.max(fromId, edge.toId);
          const t = ts.get(`${lo},${hi}`)!;
          const canonical = fromId < edge.toId;
          adj.get(fromId)!.push(...parallelSidewalkEdges(fromId, edge, t.left[0], t.right[0]).map((s) => ({
            ...s,
            timeShadow: s.side === "left" ? (canonical ? t.left : t.right) : (canonical ? t.right : t.left),
          })));
        }
      }
      const rg: RoutingGraph = { nodes: graph.nodes, adj };
      const results = paretoRoutes(rg, snapToGraph(route.a, rg), snapToGraph(route.b, rg), {
        crossingPenaltyM: 15, solarIntensity: 0.5, straightLineDistM: 4000, travelMode: "walk", objective: "sun",
        timeAware: { bucketMs: 15 * 60_000, bucketCount: 8 },
      });
      process.stderr.write(`${JSON.stringify({
        route: route.name, nodes: graph.nodes.size, edges: keys.length, missing,
        routes: results.map((r) => ({ km: +(r.distanceM / 1000).toFixed(2), shadow: +(r.shadowCoverage * 100).toFixed(1) })),
      })}\n`);
    }
  });
});
