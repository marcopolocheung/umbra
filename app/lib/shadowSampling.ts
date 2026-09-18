/**
 * Pure functions for sampling shadow from the map canvas and computing solar intensity.
 * Extracted from page.tsx — no React dependency.
 */

/**
 * Detect the blue-dominant shadow overlay emitted by LocalShadowAdapter after it
 * has been composited over the basemap.
 */
export function isBlueDominantShadowPixel(r: number, g: number, b: number): boolean {
  const avgRG = (r + g) / 2;
  return r + g + b < 600 && b - avgRG > 18 && b > avgRG * 1.15;
}

/**
 * Sample shadow independently for the left and right sidewalks of an edge.
 * The shadow overlay is a semi-transparent blue wash; shadowed pixels read as
 * blue-dominant (blue channel above the red/green average) regardless of how
 * light or dark the underlying basemap is.
 *
 * `from`/`to` are [lng, lat] in the CANONICAL direction (used to define left/right
 * consistently). The caller is responsible for passing a canonical (low→high nodeId)
 * direction so that left/right are stable across bidirectional edge pairs.
 *
 * Returns { left, right } shadow fractions (0–1), sampled at ±4 m perpendicular
 * offsets. These are assigned to separate parallel edges in the routing graph so
 * Dijkstra can pick the shadowed sidewalk without any change to the core algorithm.
 */
export function sampleBothSidewalks(
  projectFn: (lng: number, lat: number) => [number, number],
  imageData: ImageData,
  dpr: number,
  from: [number, number], // [lng, lat], canonical direction
  to: [number, number],
  samples = 5
): { left: number; right: number } {
  const { data, width, height } = imageData;

  const sampleLine = (oLng: number, oLat: number): number => {
    let shadowSum = 0;
    let count = 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const lng = from[0] + t * (to[0] - from[0]) + oLng;
      const lat = from[1] + t * (to[1] - from[1]) + oLat;
      const [px, py] = projectFn(lng, lat);
      const x = Math.round(px * dpr);
      const y = Math.round(py * dpr);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      // The shadow overlay is a semi-transparent BLUE wash (LocalShadowAdapter
      // BASE/NOON_RGB) composited over the basemap. Its signature — independent
      // of basemap brightness — is that blue exceeds the red/green average.
      // (An absolute `r+g+b<200` dark gate breaks over the light outdoor-v2
      // basemap, where a blended shadow pixel is ~ (70,81,102): blue-dominant
      // but not dark.) Reject very bright pixels (sky/labels) and keep a strong
      // blue margin so green parkland and neutral roads stay unshadowed.
      shadowSum += isBlueDominantShadowPixel(r, g, b) ? 1 : 0;
      count++;
    }
    return count === 0 ? 0 : shadowSum / count;
  };

  const SIDEWALK_OFFSET_M = 4.0;
  const latMid = (from[1] + to[1]) / 2;
  const cosLat = Math.max(1e-10, Math.cos(latMid * Math.PI / 180));
  const dx = (to[0] - from[0]) * cosLat;
  const dy = to[1] - from[1];
  const len = Math.sqrt(dx * dx + dy * dy);

  let perpLng = 0, perpLat = 0;
  if (len > 1e-10) {
    perpLng = (-dy / len) * (SIDEWALK_OFFSET_M / (111195 * cosLat));
    perpLat = ( dx / len) * (SIDEWALK_OFFSET_M / 111195);
  }

  return {
    left:  sampleLine( perpLng,  perpLat),   // left  sidewalk of canonical direction
    right: sampleLine(-perpLng, -perpLat),   // right sidewalk of canonical direction
  };
}

/** Sample a renderer-owned building mask without classifying composited map colours. */
export function sampleBuildingMaskBothSidewalks(
  projectFn: (lng: number, lat: number) => [number, number],
  mask: {
    data: Uint8Array;
    width: number;
    height: number;
    pixelRatioX: number;
    pixelRatioY: number;
  },
  from: [number, number],
  to: [number, number],
  samples = 5,
): { left: number; right: number } {
  const sampleLine = (oLng: number, oLat: number): number => {
    let shadow = 0;
    let count = 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const [px, py] = projectFn(
        from[0] + t * (to[0] - from[0]) + oLng,
        from[1] + t * (to[1] - from[1]) + oLat,
      );
      const x = Math.round(px * mask.pixelRatioX);
      const y = Math.round(py * mask.pixelRatioY);
      if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) continue;
      shadow += mask.data[y * mask.width + x] / 255;
      count++;
    }
    return count === 0 ? 0 : shadow / count;
  };

  const latMid = (from[1] + to[1]) / 2;
  const cosLat = Math.max(1e-10, Math.cos((latMid * Math.PI) / 180));
  const dx = (to[0] - from[0]) * cosLat;
  const dy = to[1] - from[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const oLng = len > 1e-10 ? (-dy / len) * (4 / (111195 * cosLat)) : 0;
  const oLat = len > 1e-10 ? (dx / len) * (4 / 111195) : 0;
  return { left: sampleLine(oLng, oLat), right: sampleLine(-oLng, -oLat) };
}

/**
 * Computes solar intensity (0–1) proportional to sin(solar elevation angle).
 * Returns 0 at/below the horizon, ~1 at solar noon zenith.
 * Uses low-precision orbital mechanics accurate to ~1° — sufficient for
 * shadow-routing weighting purposes.
 */
export function computeSolarIntensity(date: Date, latDeg: number, lngDeg: number): number {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * (Math.PI / 180);
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * (Math.PI / 180);
  const epsilon = (23.439 - 0.0000004 * n) * (Math.PI / 180);
  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const GMST = (280.46061837 + 360.98564736629 * n) % 360;
  const HA = ((GMST + lngDeg - Math.atan2(
    Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)
  ) * (180 / Math.PI)) % 360) * (Math.PI / 180);
  const latRad = latDeg * (Math.PI / 180);
  const sinElev = Math.sin(latRad) * Math.sin(declination)
                + Math.cos(latRad) * Math.cos(declination) * Math.cos(HA);
  return Math.max(0, sinElev);
}

/**
 * Pick the station door that makes the shortest trip between `from` and the
 * platform: street walk to the door plus the walk inside from door to platform.
 * Prefers actual entrance nodes (kind === "entrance") over station centroids.
 *
 * Both legs count because the walk inside is real distance the rider covers.
 * Ranking on the street leg alone chose whichever door sat nearest the
 * destination, however far along the complex from the train: at Grand Central
 * it put the 7's exit on a terminal door 87 m from the platform over a street
 * stair 32 m away. Over NYC it cut the median door-to-platform distance from 58
 * to 40 m and the worst from 351 to 275 m.
 */
export function pickClosestEntrance(
  from: [number, number], // [lng, lat]
  platform: { lat: number; lon: number },
  candidates: Array<{ lat: number; lon: number; kind?: string }>,
  haversineMeters: (a: [number, number], b: [number, number]) => number
): { lat: number; lon: number } {
  if (candidates.length === 0) throw new Error("pickClosestEntrance: empty candidates");

  // Prefer actual entrance nodes when present, otherwise fall back to stations.
  const entrances = candidates.filter((c) => c.kind === "entrance");
  const pool = entrances.length > 0 ? entrances : candidates;

  let best = pool[0];
  let bestDist = Infinity;
  for (const c of pool) {
    const d =
      haversineMeters(from, [c.lon, c.lat]) +
      haversineMeters([c.lon, c.lat], [platform.lon, platform.lat]);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return { lat: best.lat, lon: best.lon };
}
