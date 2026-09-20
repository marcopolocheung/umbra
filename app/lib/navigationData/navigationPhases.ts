/**
 * Per-calculation navigation instrumentation (Checkpoint 6).
 *
 * One collector is created per route calculation in `useRouting` and threaded
 * through the snapshot acquisition, the street-graph source, the static
 * building provider, and `ShadowField.sampleEdges`. Every field is a count, a
 * byte figure, a phase duration, or a source label — deliberately no route
 * coordinates and no user inputs, so the same values are safe to log in
 * production and to expose on `window.__umbraMetrics`.
 *
 * The phase split attributes the former combined `graphFetch` span:
 *
 *   pointer/manifest   → pointer + manifest + digest verify
 *   street transfer    → waiting on the street shard bytes (fetch side only)
 *   digest verify      → SHA-256 + byte-count contract checks on those bytes
 *   decode/parse       → JSON.parse + shard-schema adaptation
 *   graph merge        → `buildRoutingGraphFromStreetShards` union by id
 *   building transfer  → waiting on the building shard bytes
 *   building verify    → SHA-256 + byte-count contract checks on those bytes
 *   building decode    → JSON.parse + building-schema adaptation
 *   prism conversion   → `prismsFromFootprints` materialization
 *   shadow-index prep  → caster triangulation + per-cell shadow index build
 *
 * `fieldReady` in the existing metrics keeps its historic meaning (the whole
 * awaited readiness tail, which overlaps the street phases by construction);
 * the new fields attribute the parts of it that are static navigation data.
 * `shadowSample` keeps covering its full span; `shadowIndexPrep` is the
 * one-time subset of it that builds indices before the per-point walk.
 *
 * All phase fields accumulate milliseconds and all counters accumulate, so a
 * shared fetch measured in two callers only pays in one of them.
 */

import type {
  NavigationBuildingShard,
  NavigationStreetShard,
} from "./shardContract";

/**
 * Byte estimates for decoded shard objects, not idempotent measurements.
 *
 * Re-encoding each decoded shard just to weigh it would charge the route one
 * extra JSON.stringify per shard (the decoded cache is the point of the whole
 * feature), so retained bytes are estimated from the schema the loader just
 * validated: a street node is ~58 characters of JSON, a directed edge ~145, a
 * building ~120 plus ~18 per ring point. These constants were fitted against
 * the committed `navigationShards` fixture and stay conservative; they are
 * estimates for sizing the decoded cache, not receipts.
 */
export const STREET_NODE_ESTIMATE_BYTES = 58;
export const STREET_EDGE_ESTIMATE_BYTES = 145;
export const BUILDING_BASE_ESTIMATE_BYTES = 120;
export const BUILDING_RING_POINT_ESTIMATE_BYTES = 18;

export type NavigationStreetSource = "nyc-static" | "overpass" | "none";

export class NavigationPhases {
  pointerMs = 0;
  manifestMs = 0;
  streetTransferMs = 0;
  streetVerifyMs = 0;
  streetDecodeMs = 0;
  streetMergeMs = 0;
  buildingTransferMs = 0;
  buildingVerifyMs = 0;
  buildingDecodeMs = 0;
  buildingConvertMs = 0;
  shadowIndexPrepMs = 0;

  /** Selected street refs answered by the decoded generation cache. */
  streetShardsServed = 0;
  /** Selected street refs that needed a fetch (HTTP cache may still serve bytes). */
  streetShardsFetched = 0;
  streetTransferBytes = 0;
  /** Sum of the selected refs' published node counts (includes seam ghosts). */
  streetRefNodes = 0;
  /** Sum of the selected refs' published directed-edge counts. */
  streetRefEdges = 0;
  /** Merged graph size, filled once the adapter runs. */
  streetMergedNodes = 0;
  streetMergedEdges = 0;
  streetDecodedBytesEstimate = 0;

  buildingShardsServed = 0;
  buildingShardsFetched = 0;
  buildingTransferBytes = 0;
  /** Sum of the selected building refs' published feature counts. */
  buildingRefCount = 0;
  /** Prisms actually published for this calculation's query. */
  buildingPrismCount = 0;
  buildingDecodedBytesEstimate = 0;
  /** The static provider's synchronous prism cache answered its `load` call. */
  buildingPrismCacheHit = false;

  /** Pointer generation cache: manifest skipped because the generation matched. */
  snapshotGenerationCacheHit = false;

  streetSource: NavigationStreetSource = "none";
  /**
   * Why the static attempt was declined or failed. Shard keys and HTTP
   * statuses only — never coordinates or route data.
   */
  streetFallbackReason: string | null = null;
  generation: string | null = null;
}

export function newNavigationPhases(): NavigationPhases {
  return new NavigationPhases();
}

export function estimateStreetShardDecodedBytes(shard: NavigationStreetShard): number {
  return (
    shard.nodes.length * STREET_NODE_ESTIMATE_BYTES + shard.edges.length * STREET_EDGE_ESTIMATE_BYTES
  );
}

export function estimateBuildingShardDecodedBytes(shard: NavigationBuildingShard): number {
  let ringPoints = 0;
  for (const building of shard.buildings) {
    for (const ring of building.rings) ringPoints += ring.length;
  }
  return (
    shard.buildings.length * BUILDING_BASE_ESTIMATE_BYTES +
    ringPoints * BUILDING_RING_POINT_ESTIMATE_BYTES
  );
}
