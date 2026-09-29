import SunCalc from "suncalc";
import { fetchBuildingFootprintsAround, type BuildingFootprint } from "../overpass";
import { metersPerDegree, prismsFromFootprints } from "../shadowField/geometry";
import { buildShadowIndex } from "../shadowField/shadowIndex";

export interface OffscreenShadowResult {
  shadowFraction: number;
  source: "overpass-buildings";
  buildingCount: number;
}

export async function queryOffscreenBuildingShadow(
  lng: number,
  lat: number,
  date: Date,
  signal?: AbortSignal
): Promise<OffscreenShadowResult> {
  const buildings = await fetchBuildingFootprintsAround(lng, lat, 180, signal);
  return {
    shadowFraction: computeBuildingShadowFraction(lng, lat, date, buildings),
    source: "overpass-buildings",
    buildingCount: buildings.length,
  };
}

/** Largest square half-side, in metres, that one multi-point prefetch may ask for. */
const PREFETCH_MAX_RADIUS_M = 750;

/**
 * Fetch footprints once for a set of points, so that each point's own
 * `queryOffscreenBuildingShadow` then answers from the footprint cache instead of
 * a round-trip each. The square covers every point's 180 m box; it is skipped when
 * it would exceed `PREFETCH_MAX_RADIUS_M`, and a failure leaves the per-point path
 * to fetch as before.
 */
export async function prefetchBuildingFootprints(
  points: Array<{ lng: number; lat: number }>,
  signal?: AbortSignal
): Promise<void> {
  if (points.length < 2) return;
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const p of points) {
    const { mPerLng } = metersPerDegree(p.lat);
    south = Math.min(south, p.lat - 180 / 111320);
    north = Math.max(north, p.lat + 180 / 111320);
    west = Math.min(west, p.lng - 180 / mPerLng);
    east = Math.max(east, p.lng + 180 / mPerLng);
  }
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  const radiusM =
    Math.max(((north - south) / 2) * 111320, ((east - west) / 2) * metersPerDegree(lat).mPerLng) + 1;
  if (radiusM > PREFETCH_MAX_RADIUS_M) return;
  try {
    await fetchBuildingFootprintsAround(lng, lat, radiusM, signal);
  } catch {
    // The per-point fetches that follow retry and report their own errors.
  }
}

export function computeBuildingShadowFraction(
  lng: number,
  lat: number,
  date: Date,
  buildings: BuildingFootprint[]
): number {
  const sun = SunCalc.getPosition(date, lat, lng);
  if (sun.altitude <= 0) return 1;

  const { prisms } = prismsFromFootprints(buildings);
  const { mPerLat, mPerLng } = metersPerDegree(lat);
  const offsetsM: Array<[number, number]> = [
    [0, 0],
    [-4, 0],
    [4, 0],
    [0, -4],
    [0, 4],
  ];

  // One build for all five offsets. They already shared this sun and this projection
  // frame, so these are the same shadows the per-query path rebuilt five times over.
  const shadows = buildShadowIndex(prisms, sun.azimuth, sun.altitude, mPerLat, mPerLng, null);

  let shadowed = 0;
  for (const [dxM, dyM] of offsetsM) {
    const sampleLng = lng + dxM / mPerLng;
    const sampleLat = lat + dyM / mPerLat;
    if (shadows.isShadowed(sampleLng, sampleLat)) {
      shadowed++;
    }
  }

  return shadowed / offsetsM.length;
}
