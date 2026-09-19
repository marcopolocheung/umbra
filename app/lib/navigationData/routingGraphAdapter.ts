/**
 * Builds a `RoutingGraph` out of published static street shards.
 *
 * This replaces `fetchRoutingGraph`'s *producer*, not its interface: everything
 * downstream — shadow sampling, sidewalk expansion, snapping, `dijkstra`,
 * `paretoRoutes`, transit access/egress walks — consumes the same shape it
 * always has, with `shadowFactor` initialized to 0 for the caller to fill in.
 *
 * Each shard owns its directed edges exactly once and carries ghost endpoint
 * nodes for edges crossing into an adjacent cell, so the merge is a union by
 * stable identity, not a geometric stitch:
 *
 * - nodes merge by numeric OSM id; a shared id with different coordinates is
 *   irreconcilable and throws, so the caller falls back for the whole request
 *   instead of routing over a half-static graph;
 * - `isIntersection` merges by OR: a ghost copy may only have seen one of the
 *   node's ways, while the owner cell saw the rest, and the flag answers a
 *   global question ("appears in ≥2 ways") that no single shard observes
 *   alone;
 * - directed edges dedupe by content identity (endpoints, distance, tags): a
 *   seam edge published by both cells collapses to one, while the same
 *   directed pair with different content is a conflict and throws;
 * - shard-carried `distanceM` is used verbatim — it is digest-verified
 *   producer output computed with the same haversine the Overpass builder
 *   uses, so recomputing it here would only add a second opinion.
 */

import type { GraphEdge, OsmNode, RoutingGraph } from "../routing";
import type { NavigationStreetEdge, NavigationStreetShard, NavigationStreetTags } from "./shardContract";

/** The tag fields `GraphEdge` carries, in a fixed order for identity keys. */
const TAG_FIELDS = [
  "highway",
  "surface",
  "smoothness",
  "cycleway",
  "bicycle",
  "foot",
  "access",
] as const;

/**
 * Order-independent content key for one directed edge. Tag objects with the
 * same fields in a different insertion order are the same edge — `JSON.stringify`
 * would not see that, so the fields are read in contract order instead.
 */
function edgeContentKey(edge: NavigationStreetEdge): string {
  // NUL-separated: distance and tags are free text, so plain concatenation
  // could fuse two different pairs into one key.
  return [edge.distanceM, ...TAG_FIELDS.map((field) => edge.tags[field] ?? "")].join("\u0000");
}

type EdgeTagFields = Pick<
  GraphEdge,
  "highway" | "surface" | "smoothness" | "cycleway" | "bicycle" | "foot" | "access"
>;

/** Copies the shard's tag record onto an edge, omitting absent tags. */
function edgeTagFields(tags: NavigationStreetTags): EdgeTagFields {
  return {
    ...(tags.highway !== undefined ? { highway: tags.highway } : {}),
    ...(tags.surface !== undefined ? { surface: tags.surface } : {}),
    ...(tags.smoothness !== undefined ? { smoothness: tags.smoothness } : {}),
    ...(tags.cycleway !== undefined ? { cycleway: tags.cycleway } : {}),
    ...(tags.bicycle !== undefined ? { bicycle: tags.bicycle } : {}),
    ...(tags.foot !== undefined ? { foot: tags.foot } : {}),
    ...(tags.access !== undefined ? { access: tags.access } : {}),
  };
}

/**
 * Merges verified street shards from one pinned snapshot into a `RoutingGraph`.
 *
 * All shards must belong to the same generation — the loader (`remoteNavigation`)
 * pins that before this runs, so a generation check here would only restate it.
 * Throws on any identity conflict; the caller treats that as a whole-request
 * static failure and falls back to Overpass.
 */
export function buildRoutingGraphFromStreetShards(
  shards: NavigationStreetShard[],
): RoutingGraph {
  const nodes = new Map<number, OsmNode>();
  for (const shard of shards) {
    for (const node of shard.nodes) {
      const existing = nodes.get(node.id);
      if (!existing) {
        nodes.set(node.id, {
          id: node.id,
          lat: node.lat,
          lon: node.lon,
          isIntersection: node.isIntersection,
        });
        continue;
      }
      if (existing.lat !== node.lat || existing.lon !== node.lon) {
        throw new Error(
          `static street shards disagree on node ${node.id} coordinates (${shard.generation})`,
        );
      }
      existing.isIntersection = existing.isIntersection || node.isIntersection;
    }
  }

  const adj = new Map<number, GraphEdge[]>();
  const ensureAdj = (id: number) => {
    if (!adj.has(id)) adj.set(id, []);
  };

  // Directed pair → first-seen content key. An exact repeat (a seam edge both
  // cells publish) is skipped; the same pair with different content means two
  // shards describe different streets under one identity.
  const pairContent = new Map<string, string>();

  for (const shard of shards) {
    for (const edge of shard.edges) {
      const fromNode = nodes.get(edge.from);
      const toNode = nodes.get(edge.to);
      if (!fromNode || !toNode) {
        throw new Error(
          `static street edge ${edge.id} references an unpublished node (${shard.generation})`,
        );
      }
      const pairKey = `${edge.from}>${edge.to}`;
      const contentKey = edgeContentKey(edge);
      const prior = pairContent.get(pairKey);
      if (prior !== undefined) {
        if (prior !== contentKey) {
          throw new Error(
            `static street shards disagree on edge ${edge.from}→${edge.to} (${shard.generation})`,
          );
        }
        continue;
      }
      pairContent.set(pairKey, contentKey);

      ensureAdj(edge.from);
      ensureAdj(edge.to);
      adj.get(edge.from)!.push({
        toId: edge.to,
        distanceM: edge.distanceM,
        shadowFactor: 0,
        ...edgeTagFields(edge.tags),
      });
    }
  }

  return { nodes, adj };
}
