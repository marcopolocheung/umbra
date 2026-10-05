/**
 * Transferable form of a `RoutingGraph` for `app/workers/routing.worker.ts`
 * (L3c, #263, plan on #270).
 *
 * Structured-cloning the object graph would itself be a main-thread long task
 * (~266k edge objects on a long walk), so the graph crosses as flat typed
 * arrays whose buffers transfer, and the worker rebuilds the `Map`s. Every
 * number stays Float64, so values are bit-identical; optional fields absent
 * here stay absent there; and `nodes` / `adj` keys and each node's edges keep
 * their original iteration order — search order, and therefore tie-breaks,
 * depend on it.
 *
 * Only the fields the search reads cross: `name` (guidance) does not.
 */

import type { GraphEdge, OsmNode, RoutingGraph } from "./routing";

const TAGS = ["highway", "surface", "smoothness", "cycleway", "bicycle", "foot", "access"] as const;
type Tag = (typeof TAGS)[number];

/** Presence bits for the optional numeric edge fields (a present NaN stays NaN). */
const HAS_SHELTER = 1;
const HAS_SHELTER_CONF = 2;
const HAS_EXPOSURE_CONF = 4;

export interface PackedRoutingGraph {
  /** Index → node id. Float64: OSM ids pass 2^31 and virtual snap ids are negative. */
  nodeIds: Float64Array;
  /** Node count of `graph.nodes`; those ids are indices 0..nodeRecordCount−1, in `nodes` order. */
  nodeRecordCount: number;
  lat: Float64Array;
  lon: Float64Array;
  /** 1 when the node record has `isIntersection: true`. */
  isIntersection: Uint8Array;
  /** Node index of each `graph.adj` key, in `adj` order (includes keys with no edges). */
  adjOrder: Int32Array;
  /** Edges in `adj` order: key k's edges are adjOffsets[k] .. adjOffsets[k + 1]. */
  adjOffsets: Int32Array;
  /** Edge → target node index. */
  targets: Int32Array;
  distanceM: Float64Array;
  shadowFactor: Float64Array;
  shelterFactor: Float64Array;
  shelterConfidence: Float64Array;
  exposureConfidence: Float64Array;
  /** HAS_* bits per edge. */
  present: Uint8Array;
  /** 0 = none, 1 = left, 2 = right. */
  side: Uint8Array;
  /** Per edge: `timeShadow` length, −1 when absent (distinct from an empty array). */
  timeShadowLength: Int32Array;
  /** Every present `timeShadow`, concatenated in edge order. */
  timeShadowValues: Float64Array;
  /** Per tag, per edge: index into `strings`, −1 when absent. */
  tags: Record<Tag, Int32Array>;
  strings: string[];
}

/** Edges packed between yields of `packRoutingGraphInSteps`. */
const EDGES_PER_STEP = 4096;

export function packRoutingGraph(graph: RoutingGraph): PackedRoutingGraph {
  const steps = packRoutingGraphInSteps(graph);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * The pack, yielding every `EDGES_PER_STEP` edges so a caller can spread it
 * over several tasks (~130 ms in Chromium on a 134k-edge graph is itself a
 * long task). The graph must not change between steps.
 */
export function* packRoutingGraphInSteps(graph: RoutingGraph): Generator<void, PackedRoutingGraph> {
  const indexOf = new Map<number, number>();
  const ids: number[] = [];
  for (const id of graph.nodes.keys()) {
    indexOf.set(id, ids.length);
    ids.push(id);
  }
  const indexFor = (id: number): number => {
    let i = indexOf.get(id);
    if (i === undefined) {
      i = ids.length;
      indexOf.set(id, i);
      ids.push(id);
    }
    return i;
  };

  let edgeCount = 0;
  let timeShadowCount = 0;
  for (const edges of graph.adj.values()) {
    edgeCount += edges.length;
    for (const edge of edges) if (edge.timeShadow) timeShadowCount += edge.timeShadow.length;
  }

  const adjOrder = new Int32Array(graph.adj.size);
  const adjOffsets = new Int32Array(graph.adj.size + 1);
  const targets = new Int32Array(edgeCount);
  const distanceM = new Float64Array(edgeCount);
  const shadowFactor = new Float64Array(edgeCount);
  const shelterFactor = new Float64Array(edgeCount);
  const shelterConfidence = new Float64Array(edgeCount);
  const exposureConfidence = new Float64Array(edgeCount);
  const present = new Uint8Array(edgeCount);
  const side = new Uint8Array(edgeCount);
  const timeShadowLength = new Int32Array(edgeCount);
  const timeShadowValues = new Float64Array(timeShadowCount);
  const highway = new Int32Array(edgeCount);
  const surface = new Int32Array(edgeCount);
  const smoothness = new Int32Array(edgeCount);
  const cycleway = new Int32Array(edgeCount);
  const bicycle = new Int32Array(edgeCount);
  const foot = new Int32Array(edgeCount);
  const access = new Int32Array(edgeCount);
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const intern = (s: string | undefined): number => {
    if (s === undefined) return -1;
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };

  let k = 0;
  let e = 0;
  let v = 0;
  for (const [id, edges] of graph.adj) {
    adjOrder[k] = indexFor(id);
    adjOffsets[k++] = e;
    for (const edge of edges) {
      targets[e] = indexFor(edge.toId);
      distanceM[e] = edge.distanceM;
      shadowFactor[e] = edge.shadowFactor;
      let bits = 0;
      if (edge.shelterFactor !== undefined) {
        shelterFactor[e] = edge.shelterFactor;
        bits |= HAS_SHELTER;
      }
      if (edge.shelterConfidence !== undefined) {
        shelterConfidence[e] = edge.shelterConfidence;
        bits |= HAS_SHELTER_CONF;
      }
      if (edge.exposureConfidence !== undefined) {
        exposureConfidence[e] = edge.exposureConfidence;
        bits |= HAS_EXPOSURE_CONF;
      }
      present[e] = bits;
      side[e] = edge.side === "left" ? 1 : edge.side === "right" ? 2 : 0;
      const ts = edge.timeShadow;
      if (ts) {
        timeShadowLength[e] = ts.length;
        for (let j = 0; j < ts.length; j++) timeShadowValues[v++] = ts[j];
      } else {
        timeShadowLength[e] = -1;
      }
      highway[e] = intern(edge.highway);
      surface[e] = intern(edge.surface);
      smoothness[e] = intern(edge.smoothness);
      cycleway[e] = intern(edge.cycleway);
      bicycle[e] = intern(edge.bicycle);
      foot[e] = intern(edge.foot);
      access[e] = intern(edge.access);
      e++;
      if (e % EDGES_PER_STEP === 0) yield;
    }
  }
  adjOffsets[k] = e;

  const nodeCount = ids.length;
  const lat = new Float64Array(nodeCount);
  const lon = new Float64Array(nodeCount);
  const isIntersection = new Uint8Array(nodeCount);
  let n = 0;
  for (const node of graph.nodes.values()) {
    lat[n] = node.lat;
    lon[n] = node.lon;
    if (node.isIntersection) isIntersection[n] = 1;
    n++;
  }

  return {
    nodeIds: new Float64Array(ids),
    nodeRecordCount: graph.nodes.size,
    lat,
    lon,
    isIntersection,
    adjOrder,
    adjOffsets,
    targets,
    distanceM,
    shadowFactor,
    shelterFactor,
    shelterConfidence,
    exposureConfidence,
    present,
    side,
    timeShadowLength,
    timeShadowValues,
    tags: { highway, surface, smoothness, cycleway, bicycle, foot, access },
    strings,
  };
}

/** The buffers to pass as `postMessage`'s transfer list. */
export function transferList(packed: PackedRoutingGraph): ArrayBuffer[] {
  return [
    packed.nodeIds,
    packed.lat,
    packed.lon,
    packed.isIntersection,
    packed.adjOrder,
    packed.adjOffsets,
    packed.targets,
    packed.distanceM,
    packed.shadowFactor,
    packed.shelterFactor,
    packed.shelterConfidence,
    packed.exposureConfidence,
    packed.present,
    packed.side,
    packed.timeShadowLength,
    packed.timeShadowValues,
    ...TAGS.map((t) => packed.tags[t]),
  ].map((a) => a.buffer as ArrayBuffer);
}

export function unpackRoutingGraph(packed: PackedRoutingGraph): RoutingGraph {
  const { nodeIds, adjOrder, adjOffsets, targets, present, side, timeShadowLength, timeShadowValues, strings } = packed;
  const { highway, surface, smoothness, cycleway, bicycle, foot, access } = packed.tags;
  const nodes = new Map<number, OsmNode>();
  for (let i = 0; i < packed.nodeRecordCount; i++) {
    const node: OsmNode = { id: nodeIds[i], lat: packed.lat[i], lon: packed.lon[i] };
    if (packed.isIntersection[i]) node.isIntersection = true;
    nodes.set(nodeIds[i], node);
  }

  const adj = new Map<number, GraphEdge[]>();
  let v = 0;
  for (let k = 0; k < adjOrder.length; k++) {
    const end = adjOffsets[k + 1];
    const edges: GraphEdge[] = new Array(end - adjOffsets[k]);
    for (let e = adjOffsets[k], j = 0; e < end; e++, j++) {
      const edge: GraphEdge = {
        toId: nodeIds[targets[e]],
        distanceM: packed.distanceM[e],
        shadowFactor: packed.shadowFactor[e],
      };
      const bits = present[e];
      if (bits & HAS_SHELTER) edge.shelterFactor = packed.shelterFactor[e];
      if (bits & HAS_SHELTER_CONF) edge.shelterConfidence = packed.shelterConfidence[e];
      if (bits & HAS_EXPOSURE_CONF) edge.exposureConfidence = packed.exposureConfidence[e];
      if (side[e] === 1) edge.side = "left";
      else if (side[e] === 2) edge.side = "right";
      if (highway[e] >= 0) edge.highway = strings[highway[e]];
      if (surface[e] >= 0) edge.surface = strings[surface[e]];
      if (smoothness[e] >= 0) edge.smoothness = strings[smoothness[e]];
      if (cycleway[e] >= 0) edge.cycleway = strings[cycleway[e]];
      if (bicycle[e] >= 0) edge.bicycle = strings[bicycle[e]];
      if (foot[e] >= 0) edge.foot = strings[foot[e]];
      if (access[e] >= 0) edge.access = strings[access[e]];
      const len = timeShadowLength[e];
      if (len >= 0) {
        const ts: number[] = new Array(len);
        for (let t = 0; t < len; t++) ts[t] = timeShadowValues[v++];
        edge.timeShadow = ts;
      }
      edges[j] = edge;
    }
    adj.set(nodeIds[adjOrder[k]], edges);
  }
  return { nodes, adj };
}
