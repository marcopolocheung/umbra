/**
 * A1: synchronous shade-window search over loaded, verified NYC table shards.
 * No fetching, current clock, signatures, or shadow simulation. Dates select
 * a typical monthly day; all values retain the table's 15-minute resolution.
 */
import SunCalc from "suncalc";
import {
  bearingDegrees,
  haversineMeters,
  swapSideAgainstCanonical,
  type SidewalkSide,
} from "../routing";
import { sidewalkOffsets, type EdgeRef } from "../shadowField/ShadowField";
import { partitionSunCells } from "../shadowField/sunCells";
import { fromZonedParts } from "../timezone";
import { buildRoutingGraphFromStreetShards } from "./routingGraphAdapter";
import {
  SHADE_DAY_START_MINUTES,
  SHADE_DAY_SLOTS,
  SHADE_REPRESENTATIVE_DAY,
  SHADE_REPRESENTATIVE_YEAR,
  SHADE_SLOT_COUNT,
  SHADE_SLOT_MINUTES,
  SHADE_ZONE,
  shadeSegmentKey,
  shadeSlotIndex,
} from "./shadeSlots";
import {
  createShadeTableView,
  QUARANTINED_SHADE_GENERATIONS,
  type ShadeTableShard,
  type ShadeTableView,
} from "./shadeTable";
import type { NavigationStreetShard } from "./shardContract";

export interface ShadeSpotsQuery {
  lat: number;
  lng: number;
  /** ISO calendar date; its month selects the fixed 2026 representative day. */
  date: string;
  /** NYC clock minutes; same-day half-open window, 0 <= from < to <= 1440. */
  fromMinutes: number;
  toMinutes: number;
  radiusM: 200 | 400 | 800;
  mode: "shade" | "sun";
}

export interface ShadeSpotWindow {
  fromMinutes: number;
  toMinutes: number;
}

export type ShadeSpotsReason =
  | "snapped"
  | "table-clipped"
  | "daylight-clipped"
  | "empty-window"
  | "night"
  | "incomplete-data"
  | "no-data"
  | "no-candidates";

export interface ShadeSpotSample {
  slot: number;
  /** NYC clock minute on the representative day. */
  minutes: number;
  shade: number;
}

export interface ShadeSpot {
  candidateId: string;
  segmentKey: string;
  /** Canonical side: lower node ID -> higher node ID. */
  side: SidewalkSide;
  /** Topological block-face approximation within loaded street geometry. */
  blockFaceId: string;
  label: string;
  lat: number;
  lng: number;
  /** Distance to the segment centreline midpoint, used for radius and ties. */
  distanceM: number;
  meanShade: number;
  hours: ShadeSpotSample[];
  effectiveWindow: ShadeSpotWindow;
}

export interface ShadeSpotsResult {
  generation: string | null;
  requestedWindow: ShadeSpotWindow;
  /** After snapping and table clipping; daylight windows are per candidate. */
  effectiveWindow: ShadeSpotWindow | null;
  basis: { representativeDate: string; zone: typeof SHADE_ZONE; slotMinutes: number };
  reasons: ShadeSpotsReason[];
  /** Number of eligible segments skipped for missing geometry or samples. */
  skippedSegments: number;
  /** Loaded shade-index rows lacking geometry; their radius is unknown. */
  missingGeometrySegments: number;
  results: ShadeSpot[];
}

interface SpotSegment {
  key: string;
  lo: number;
  hi: number;
  edge: EdgeRef;
  lengthM: number;
  sunCell?: { lng: number; lat: number };
  chain: string;
  /** Direction of this segment along the deterministic chain traversal. */
  chainFrom: number;
  chainTo: number;
  name?: string;
}

export interface ShadeSpotsView {
  readonly generation: string | null;
  readonly segments: readonly SpotSegment[];
  readonly table: ShadeTableView;
  /** Shade-index segments absent from the supplied street geometry. */
  readonly missingGeometry: number;
}

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Same generation only. Complete shade-index geometry is needed to reproduce
 * the producer's daylight observer points. Never repartition a filtered batch.
 * `names` is optional supplied metadata; published v1 street shards omit names.
 */
export function createShadeSpotsView(
  streetShards: NavigationStreetShard[],
  shadeShards: ShadeTableShard[],
  names?: ReadonlyMap<string, string>,
): ShadeSpotsView {
  const generations = new Set([
    ...streetShards.map((shard) => shard.generation),
    ...shadeShards.map(({ shard }) => shard.generation),
  ]);
  if (generations.size > 1) throw new Error("shade spots require one navigation generation");
  const generation = [...generations][0] ?? null;
  if (generation !== null && QUARANTINED_SHADE_GENERATIONS.has(generation))
    throw new Error("shade spots cannot read a quarantined shade generation");
  const graph = buildRoutingGraphFromStreetShards(streetShards);
  const segments = new Map<string, SpotSegment>();
  for (const [fromId, edges] of graph.adj) {
    for (const edge of edges) {
      const lo = Math.min(fromId, edge.toId);
      const hi = Math.max(fromId, edge.toId);
      if (lo <= 0 || lo === hi) continue;
      const key = shadeSegmentKey(lo, hi);
      const from = graph.nodes.get(lo);
      const to = graph.nodes.get(hi);
      if (!from || !to) continue;
      const existing = segments.get(key);
      if (existing) {
        existing.lengthM = Math.min(existing.lengthM, edge.distanceM);
        continue;
      }
      segments.set(key, {
        key,
        lo,
        hi,
        edge: { from: [from.lon, from.lat], to: [to.lon, to.lat] },
        lengthM: edge.distanceM,
        chain: key,
        chainFrom: lo,
        chainTo: hi,
        name: names?.get(key)?.trim() || undefined,
      });
    }
  }

  // Canonicalize topology before radius/length filtering, including short edges.
  const neighbours = new Map<number, Set<number>>();
  for (const { lo, hi } of segments.values()) {
    if (!neighbours.has(lo)) neighbours.set(lo, new Set());
    if (!neighbours.has(hi)) neighbours.set(hi, new Set());
    neighbours.get(lo)!.add(hi);
    neighbours.get(hi)!.add(lo);
  }
  const boundary = (id: number) =>
    graph.nodes.get(id)?.isIntersection || neighbours.get(id)?.size !== 2;
  const visited = new Set<string>();
  function walk(start: number, next: number): void {
    const path = [start, next];
    visited.add(shadeSegmentKey(Math.min(start, next), Math.max(start, next)));
    while (!boundary(path[path.length - 1])) {
      const end = path[path.length - 1];
      const prior = path[path.length - 2];
      const after = [...neighbours.get(end)!].find((id) => id !== prior)!;
      const key = shadeSegmentKey(Math.min(end, after), Math.max(end, after));
      if (visited.has(key)) break;
      visited.add(key);
      path.push(after);
    }
    const chain = path.join(",");
    for (let i = 1; i < path.length; i++) {
      const segment = segments.get(
        shadeSegmentKey(Math.min(path[i - 1], path[i]), Math.max(path[i - 1], path[i])),
      )!;
      segment.chain = chain;
      segment.chainFrom = path[i - 1];
      segment.chainTo = path[i];
    }
  }
  const nodeIds = [...neighbours.keys()].sort((a, b) => a - b);
  for (const id of nodeIds.filter(boundary)) {
    for (const next of [...neighbours.get(id)!].sort((a, b) => a - b)) {
      if (!visited.has(shadeSegmentKey(Math.min(id, next), Math.max(id, next)))) walk(id, next);
    }
  }
  // A closed chain has no boundary: start at its smallest node/next neighbour.
  for (const id of nodeIds) {
    for (const next of [...neighbours.get(id)!].sort((a, b) => a - b)) {
      if (!visited.has(shadeSegmentKey(Math.min(id, next), Math.max(id, next)))) walk(id, next);
    }
  }

  const shadeKeys = new Set<string>();
  let missingGeometry = 0;
  for (const { shard, blocks } of shadeShards) {
    for (const [slot, block] of blocks) {
      if (
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot >= SHADE_SLOT_COUNT ||
        block.length !== shard.segments.length * 2
      )
        throw new Error("invalid shade spots slot block");
    }
    const batch: EdgeRef[] = [];
    for (const [lo, hi] of shard.segments) {
      const key = shadeSegmentKey(lo, hi);
      if (shadeKeys.has(key)) throw new Error(`duplicate shade spots segment ${key}`);
      shadeKeys.add(key);
      const segment = segments.get(key);
      if (segment) batch.push(segment.edge);
      else missingGeometry++;
    }
    // A missing edge changes every group's centroid. Skip this shard's scoring
    // until its complete geometry is available; the result reports incompleteness.
    if (batch.length !== shard.segments.length) continue;
    for (const cell of partitionSunCells(batch)) {
      for (const index of cell.members) {
        const [lo, hi] = shard.segments[index];
        segments.get(shadeSegmentKey(lo, hi))!.sunCell = cell;
      }
    }
  }
  return {
    generation,
    segments: [...segments.values()].sort((a, b) => a.lo - b.lo || a.hi - b.hi),
    table: createShadeTableView(shadeShards),
    missingGeometry,
  };
}

function queryMonth(query: ShadeSpotsQuery): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(query.date);
  if (!match) throw new Error("shade spots date must be an ISO calendar date");
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  // setUTCFullYear avoids Date.UTC's special interpretation of years 00–99.
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day)
    throw new Error("invalid shade spots calendar date");
  if (
    !Number.isFinite(query.lat) ||
    Math.abs(query.lat) > 90 ||
    !Number.isFinite(query.lng) ||
    Math.abs(query.lng) > 180 ||
    !Number.isInteger(query.fromMinutes) ||
    !Number.isInteger(query.toMinutes) ||
    query.fromMinutes < 0 ||
    query.toMinutes > 1440 ||
    query.fromMinutes >= query.toMinutes ||
    ![200, 400, 800].includes(query.radiusM) ||
    !["shade", "sun"].includes(query.mode)
  )
    throw new Error("invalid shade spots query");
  return month;
}

const COMPASS = [
  "North",
  "Northeast",
  "East",
  "Southeast",
  "South",
  "Southwest",
  "West",
  "Northwest",
];

function spotLabel(segment: SpotSegment, side: SidewalkSide, lng: number, lat: number): string {
  const bearing = bearingDegrees(segment.edge.from, segment.edge.to);
  const outward = (bearing + (side === "left" ? 270 : 90)) % 360;
  const compass = COMPASS[Math.round(outward / 45) % 8];
  return segment.name
    ? `${segment.name}, ${compass.toLowerCase()} side`
    : `${compass}-side sidewalk near ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

/** Shared, validated window/slot preparation for the core and its async loader. */
export function prepareShadeSpotsWindow(query: ShadeSpotsQuery) {
  const month = queryMonth(query);
  const requestedWindow = { fromMinutes: query.fromMinutes, toMinutes: query.toMinutes };
  const round = (minutes: number) => Math.round(minutes / SHADE_SLOT_MINUTES) * SHADE_SLOT_MINUTES;
  const snapped = { fromMinutes: round(query.fromMinutes), toMinutes: round(query.toMinutes) };
  const reasons = new Set<ShadeSpotsReason>();
  if (snapped.fromMinutes !== query.fromMinutes || snapped.toMinutes !== query.toMinutes)
    reasons.add("snapped");
  const start = Math.max(SHADE_DAY_START_MINUTES, snapped.fromMinutes);
  const end = Math.min(
    SHADE_DAY_START_MINUTES + SHADE_DAY_SLOTS * SHADE_SLOT_MINUTES,
    snapped.toMinutes,
  );
  if (start !== snapped.fromMinutes || end !== snapped.toMinutes) reasons.add("table-clipped");
  const effectiveWindow = start < end ? { fromMinutes: start, toMinutes: end } : null;
  const basis: ShadeSpotsResult["basis"] = {
    representativeDate: `${SHADE_REPRESENTATIVE_YEAR}-${String(month + 1).padStart(2, "0")}-${SHADE_REPRESENTATIVE_DAY}`,
    zone: SHADE_ZONE,
    slotMinutes: SHADE_SLOT_MINUTES,
  };
  if (start >= end) reasons.add("empty-window");
  const slots: Array<{ minutes: number; slot: number; instant: Date }> = [];
  for (let minutes = start; minutes < end; minutes += SHADE_SLOT_MINUTES) {
    slots.push({
      minutes,
      slot: shadeSlotIndex(month, (minutes - SHADE_DAY_START_MINUTES) / SHADE_SLOT_MINUTES),
      instant: fromZonedParts(
        SHADE_ZONE,
        SHADE_REPRESENTATIVE_YEAR,
        month,
        SHADE_REPRESENTATIVE_DAY,
        Math.floor(minutes / 60),
        minutes % 60,
      ),
    });
  }
  return { requestedWindow, effectiveWindow, basis, reasons: [...reasons], slots };
}

/** Exact table arithmetic once a query is snapped; no sub-slot interpolation. */
export function shadeSpots(view: ShadeSpotsView, query: ShadeSpotsQuery): ShadeSpotsResult {
  const prepared = prepareShadeSpotsWindow(query);
  const { slots } = prepared;
  const reasons = new Set(prepared.reasons);
  const response: ShadeSpotsResult = {
    generation: view.generation,
    requestedWindow: prepared.requestedWindow,
    effectiveWindow: prepared.effectiveWindow,
    basis: prepared.basis,
    reasons: [...reasons],
    skippedSegments: 0,
    missingGeometrySegments: view.missingGeometry,
    results: [],
  };
  if (!prepared.effectiveWindow) return response;
  const daylight = new Map<NonNullable<SpotSegment["sunCell"]>, typeof slots>();
  const candidates: ShadeSpot[] = [];
  let eligible = 0;
  let daylightSegments = 0;
  for (const segment of view.segments) {
    const { from, to } = segment.edge;
    const midpoint: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const distanceM = haversineMeters([query.lng, query.lat], midpoint);
    if (segment.lengthM < 15 || distanceM > query.radiusM) continue;
    eligible++;
    if (!segment.sunCell || !view.table.covers(segment.key)) {
      response.skippedSegments++;
      continue;
    }
    let active = daylight.get(segment.sunCell);
    if (!active) {
      const { lat, lng } = segment.sunCell;
      active = slots.filter(({ instant }) => SunCalc.getPosition(instant, lat, lng).altitude > 0);
      daylight.set(segment.sunCell, active);
    }
    if (active.length < slots.length) reasons.add("daylight-clipped");
    if (active.length === 0) continue;
    daylightSegments++;
    const values = active.map(({ slot }) => view.table.shadowFor(segment.key, slot));
    if (values.some((value) => value === null)) {
      response.skippedSegments++;
      continue;
    }
    const offsets = sidewalkOffsets(segment.edge);
    for (const side of ["left", "right"] as const) {
      const lng = midpoint[0] + offsets[side][0];
      const lat = midpoint[1] + offsets[side][1];
      const hours = active.map(({ slot, minutes }, index) => ({
        slot,
        minutes,
        shade: values[index]![side],
      }));
      candidates.push({
        candidateId: `${view.generation}:${segment.key}:${side}`,
        segmentKey: segment.key,
        side,
        blockFaceId: `${segment.chain}:${swapSideAgainstCanonical(segment.chainFrom, segment.chainTo, side)}`,
        label: spotLabel(segment, side, lng, lat),
        lng,
        lat,
        distanceM,
        // Sum recovered integer bytes before dividing: mathematically equal
        // windows must tie even when their sample distributions differ.
        meanShade:
          hours.reduce((sum, sample) => sum + Math.round(sample.shade * 255), 0) /
          (255 * hours.length),
        hours,
        effectiveWindow: {
          fromMinutes: active[0].minutes,
          toMinutes: active[active.length - 1].minutes + SHADE_SLOT_MINUTES,
        },
      });
    }
  }
  const sign = query.mode === "shade" ? -1 : 1;
  candidates.sort(
    (a, b) =>
      sign * (a.meanShade - b.meanShade) ||
      a.distanceM - b.distanceM ||
      compareKey(a.candidateId, b.candidateId),
  );
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.blockFaceId)) continue;
    seen.add(candidate.blockFaceId);
    response.results.push(candidate);
    if (response.results.length === 4) break;
  }
  if (response.skippedSegments > 0 || view.missingGeometry > 0) reasons.add("incomplete-data");
  if (response.results.length === 0) {
    if (response.skippedSegments > 0 || view.missingGeometry > 0 || view.generation === null)
      reasons.add("no-data");
    else if (eligible > 0 && daylightSegments === 0) reasons.add("night");
    else reasons.add("no-candidates");
  }
  response.reasons = [...reasons];
  return response;
}
