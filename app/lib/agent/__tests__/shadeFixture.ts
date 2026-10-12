import {
  createShadeSpotsView,
  shadeSpots,
  type ShadeSpotsQuery,
} from "../../navigationData/shadeSpots";
import type { NavigationStreetShard } from "../../navigationData/shardContract";
import type { ShadeTableShard } from "../../navigationData/shadeTable";
import type { ShadeWindowSuccess } from "../shadeWindows";
import type { AgentContext } from "../tools";
import type { MapObject } from "../receipts";
import type { ShadeCandidate } from "../shadeWindows";

export const SHADE_GENERATION = "nyc-2026-09-18-000000000000";
export const SHADE_QUERY: ShadeSpotsQuery = {
  lat: 40.755,
  lng: -73.985,
  date: "2026-07-04",
  fromMinutes: 840,
  toMinutes: 960,
  radiusM: 400,
  mode: "shade",
};
export const SHADE_BOUNDS = { south: 40.7, west: -74.1, north: 40.8, east: -73.9 };
export function shadeCell(id = 10, key = "cell-a") {
  const street: NavigationStreetShard = {
    version: 1,
    dataset: "nyc-navigation",
    kind: "streets",
    generation: SHADE_GENERATION,
    geometryBounds: SHADE_BOUNDS,
    supportBounds: SHADE_BOUNDS,
    nodes: [
      { id, lat: 40.755, lon: -73.9855, isIntersection: true },
      { id: id + 1, lat: 40.755, lon: -73.9845, isIntersection: true },
    ],
    edges: [
      { id: `w${id}`, from: id, to: id + 1, distanceM: 84, tags: { highway: "residential" } },
    ],
  };
  const shade: ShadeTableShard = {
    shard: {
      version: 1,
      dataset: "nyc-navigation",
      kind: "shade",
      generation: SHADE_GENERATION,
      geometryBounds: SHADE_BOUNDS,
      supportBounds: SHADE_BOUNDS,
      slots: 768,
      segments: [[id, id + 1]],
      payload: { key: `shades/${key}.bin`, bytes: 1536, sha256: "a".repeat(64) },
    },
    blocks: new Map(Array.from({ length: 768 }, (_, slot) => [slot, new Uint8Array([51, 235])])),
  };
  return { street, shade };
}
export function shadePayload(overrides: Partial<ShadeSpotsQuery> = {}): ShadeWindowSuccess {
  const query = { ...SHADE_QUERY, ...overrides };
  const { street, shade } = shadeCell();
  const result = shadeSpots(createShadeSpotsView([street], [shade]), query);
  return {
    ...result,
    generation: SHADE_GENERATION,
    status: "ok",
    source: "nyc-shade-table",
    sourceVersion: SHADE_GENERATION,
    requestedDate: query.date,
    mode: query.mode,
  };
}
export function shadeContext(): AgentContext {
  const objects: MapObject[] = [];
  const candidates = new Map<string, ShadeCandidate>();
  return {
    mapRef: { current: null },
    shadowLayerRef: { current: null },
    dateRef: { current: new Date("2026-07-04T18:00:00Z") },
    setDate: () => {},
    getUtcOffsetMin: () => -240,
    getUserLocation: () => null,
    setWaypointA: () => {},
    setWaypointB: () => {},
    setAdditionalWaypoints: () => {},
    createRoutePlanRequest: () => {
      throw new Error("Unexpected route job");
    },
    submitRoutePlan: () => {
      throw new Error("Unexpected route job");
    },
    cancelRoutePlan: () => false,
    getCurrentPlanRevision: () => 1,
    getMapObjects: () => objects,
    registerMapObjects: (items) => {
      for (const item of items) if (!objects.some((o) => o.id === item.id)) objects.push(item);
    },
    setPins: () => {},
    getShadeCandidates: () => [...candidates.values()],
    registerShadeCandidates: (items) => {
      for (const item of items) candidates.set(item.spot.candidateId, item);
    },
  };
}
