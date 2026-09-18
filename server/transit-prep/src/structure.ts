/**
 * Joins OSM structure tags onto GTFS stop-to-stop edges.
 *
 * NYC's GTFS says nothing about whether a ride is in a tunnel, on a viaduct or
 * at grade, and the difference is the whole question for shade: the G is
 * underground, the J is elevated in full sun, and the F and G share the Culver
 * Viaduct for three stops. OSM does carry it, on the rail ways.
 *
 * Measured 2026-09-17 over every `railway=subway` way in the NYC bbox: 90.0% of
 * revenue track carries an explicit determination, and every line that is
 * documented as fully underground is 100% `tunnel`-tagged with zero untagged
 * ways. See `docs/handoffs/TRANSIT_NEXT.md` §3B for the measurement and for the
 * three ways a naive count gets it wrong.
 *
 * **Absent means "not a tunnel", not "unknown."** Unlike the feed's `changeSec`
 * (#384), OSM's `tunnel` is a closed-world tag, and NYC has real at-grade and
 * open-cut running that OSM tags specifically as `cutting` and `embankment`.
 * A way that matched but carries no structure tag is therefore at grade — the
 * weakest claim here, and deliberately the one that errs towards *more* sun
 * rather than less. Claiming shade that is not there is the bug 1B was opened
 * for; this leans the other way.
 */

import type { RouteEdge, StopNode } from "./model";
import { haversineMeters, projectOnSegment } from "./util";

export interface OsmNodeRef {
  lat: number;
  lon: number;
}

export interface OsmWay {
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmNodeRef[];
}

export interface OsmRelation {
  id: number;
  tags?: Record<string, string>;
  members?: { type: string; ref: number; role: string }[];
}

export type Structure = "underground" | "elevated" | "open_cut" | "embankment" | "at_grade";

/**
 * What share of a segment runs in each structure, as a fraction of the whole
 * segment. The values sum to **at most** 1: the shortfall is the part no OSM
 * way could be matched to, so the field describes its own uncertainty and needs
 * no separate confidence number beside it.
 */
export type EdgeStructure = Partial<Record<Structure, number>>;

/**
 * GTFS route id to OSM route relation `ref`. Only the express diamonds and the
 * Staten Island Railway differ; everything else is identity. The three GTFS
 * shuttle ids all map to the one OSM `S`.
 */
const OSM_REF: Record<string, string> = {
  "6X": "<6>",
  "7X": "<7>",
  FX: "<F>",
  SI: "SIR",
  GS: "S",
  FS: "S",
  H: "S",
};

/**
 * PATH is tagged `railway=subway`, runs in the same bbox and is **not in our
 * feed**. Excluded by operator rather than by `ref` so that a renamed service
 * still goes.
 */
const EXCLUDED_OPERATOR = /Port Authority/i;

/** Metres between samples along a segment, and the bounds on how many. */
const SAMPLE_SPACING_M = 50;
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 60;

/**
 * How far a sample may sit from a way and still match it.
 *
 * A segment is sampled along the *straight line* between its two stops — not
 * along the edge's own sliced `geom`, which this join does not read — and real
 * track curves away from that line by around 100 m on the sharpest revenue
 * curves. Candidates are
 * restricted to ways carrying the same service, so a loose radius mostly just
 * matches the same line further away rather than matching the wrong line: this
 * is what stops the 7, elevated over Queens Boulevard, inheriting the E and F's
 * tunnel underneath it.
 */
const MAX_MATCH_M = 120;

/**
 * How much of a segment must match before the result is a determination at all.
 *
 * Without a floor, one sample matching out of nine yields `{underground: 0.11}`,
 * which reads as a measurement and is noise: the other 89% is unseen. Half is
 * the point where the shares describe the segment rather than a corner of it.
 */
const MIN_COVERAGE = 0.5;

export function osmRefFor(routeId: string): string {
  return OSM_REF[routeId] ?? routeId;
}

/** `null` when the way carries no structure tag at all. */
export function structureOf(tags: Record<string, string> = {}): Structure | null {
  if (tags.tunnel && tags.tunnel !== "no") return "underground";
  if (tags.bridge && tags.bridge !== "no") return "elevated";
  if (tags.cutting && tags.cutting !== "no") return "open_cut";
  if (tags.embankment && tags.embankment !== "no") return "embankment";
  return null;
}

interface Candidate {
  id: number;
  geometry: OsmNodeRef[];
  structure: Structure;
}

export type StructureIndex = Map<string, Candidate[]>;

/**
 * Groups OSM ways by the service that runs over them.
 *
 * Route-relation membership is also what keeps yards, sidings and crossovers
 * out: 43% of `railway=subway` ways carry `service=*` and have no riders, and
 * none of them belongs to a route relation.
 */
export function buildStructureIndex(
  relations: OsmRelation[],
  ways: OsmWay[],
): StructureIndex {
  const refsByWay = new Map<number, Set<string>>();
  for (const relation of relations) {
    if (EXCLUDED_OPERATOR.test(relation.tags?.operator ?? "")) continue;
    const ref = relation.tags?.ref;
    if (!ref) continue;
    for (const member of relation.members ?? []) {
      if (member.type !== "way") continue;
      let refs = refsByWay.get(member.ref);
      if (!refs) {
        refs = new Set();
        refsByWay.set(member.ref, refs);
      }
      refs.add(ref);
    }
  }

  const index: StructureIndex = new Map();
  for (const way of ways) {
    const refs = refsByWay.get(way.id);
    if (!refs || !way.geometry || way.geometry.length < 2) continue;
    const candidate: Candidate = {
      id: way.id,
      geometry: way.geometry,
      structure: structureOf(way.tags) ?? "at_grade",
    };
    for (const ref of refs) {
      let bucket = index.get(ref);
      if (!bucket) {
        bucket = [];
        index.set(ref, bucket);
      }
      bucket.push(candidate);
    }
  }
  return index;
}

function distanceToWay(p: OsmNodeRef, geometry: OsmNodeRef[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < geometry.length; i += 1) {
    const { distM } = projectOnSegment(p, geometry[i - 1] as OsmNodeRef, geometry[i] as OsmNodeRef);
    if (distM < best) best = distM;
  }
  return best;
}

/**
 * Structure shares for one stop-to-stop segment, or `undefined` when no sample
 * matched any way of that service — which is the honest answer, not a default.
 */
export function classifySegment(
  from: StopNode,
  to: StopNode,
  candidates: Candidate[] | undefined,
): EdgeStructure | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  const spanM = haversineMeters(from.lat, from.lon, to.lat, to.lon);
  const samples = Math.max(
    MIN_SAMPLES,
    Math.min(MAX_SAMPLES, Math.round(spanM / SAMPLE_SPACING_M)),
  );

  const counts = new Map<Structure, number>();
  let matched = 0;
  for (let i = 0; i <= samples; i += 1) {
    const f = i / samples;
    const point = {
      lat: from.lat + (to.lat - from.lat) * f,
      lon: from.lon + (to.lon - from.lon) * f,
    };
    let best: Candidate | undefined;
    let bestDistance = MAX_MATCH_M;
    for (const candidate of candidates) {
      const d = distanceToWay(point, candidate.geometry);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    if (!best) continue;
    matched += 1;
    counts.set(best.structure, (counts.get(best.structure) ?? 0) + 1);
  }
  const total = samples + 1;
  if (matched / total < MIN_COVERAGE) return undefined;

  const result: EdgeStructure = {};
  for (const [structure, count] of counts) {
    // Two decimals: the sampling is not precise enough to justify more, and
    // this is multiplied by every edge in the shard.
    const share = Math.round((count / total) * 100) / 100;
    if (share > 0) result[structure] = share;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface StructureStats {
  edges: number;
  determined: number;
  /** Edges whose shares do not reach 1, i.e. partly unmatched. */
  partial: number;
  byDominant: Record<string, number>;
}

/**
 * Attaches `structure` to every edge it can, and reports what it could not.
 * Edges are returned in the order given; an edge with no determination is
 * returned unchanged rather than carrying an empty object.
 */
export function attachStructure(
  edges: RouteEdge[],
  stops: StopNode[],
  index: StructureIndex,
): { edges: (RouteEdge & { structure?: EdgeStructure })[]; stats: StructureStats } {
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const stats: StructureStats = { edges: edges.length, determined: 0, partial: 0, byDominant: {} };

  const out = edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return edge;
    const structure = classifySegment(from, to, index.get(osmRefFor(edge.route)));
    if (!structure) return edge;
    stats.determined += 1;
    const entries = Object.entries(structure).sort((a, b) => b[1] - a[1]);
    const sum = entries.reduce((total, [, share]) => total + share, 0);
    if (sum < 0.995) stats.partial += 1;
    const dominant = entries[0]?.[0] ?? "none";
    stats.byDominant[dominant] = (stats.byDominant[dominant] ?? 0) + 1;
    return { ...edge, structure };
  });

  return { edges: out, stats };
}
