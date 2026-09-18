import { describe, it, expect } from "vitest";
import { haversineMeters } from "../routing";
import {
  isBlueDominantShadowPixel,
  pickClosestEntrance,
  sampleBothSidewalks,
} from "../shadowSampling";

/**
 * Build a uniform ImageData where every pixel is [r,g,b,255].
 * sampleBothSidewalks with a constant projectFn samples this single color,
 * so we can test the shadow classifier in isolation.
 */
function uniformImage(r: number, g: number, b: number, w = 8, h = 8): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, colorSpace: "srgb" } as ImageData;
}

const constProject = (): [number, number] => [4, 4];
const from: [number, number] = [0, 0];
const to: [number, number] = [0.0005, 0];

function shadowOf(r: number, g: number, b: number): number {
  const s = sampleBothSidewalks(constProject, uniformImage(r, g, b), 1, from, to, 4);
  return Math.max(s.left, s.right);
}

describe("sampleBothSidewalks shadow classifier", () => {
  it("detects a blue shadow blended over the light outdoor-v2 basemap", () => {
    // #01112f @ 0.7 alpha composited over a light (~white) road ≈ (70,81,102).
    // Blue-dominant but NOT dark (sum=253) — the case the old `r+g+b<200`
    // gate wrongly rejected.
    expect(shadowOf(70, 81, 102)).toBeGreaterThan(0.5);
  });

  it("detects a strong blue shadow over a dark feature", () => {
    expect(shadowOf(10, 21, 42)).toBeGreaterThan(0.5);
  });

  it("does NOT flag an unshadowed light road as shadowed", () => {
    expect(shadowOf(230, 230, 230)).toBe(0);
  });

  it("does NOT flag a neutral-gray shadow as shadowed (gray is undetectable by color)", () => {
    // #6b6b6b @ 0.7 over white ≈ (151,151,151): r≈g≈b, no blue signal.
    expect(shadowOf(151, 151, 151)).toBe(0);
  });

  it("does NOT flag green parkland as shadowed", () => {
    expect(shadowOf(180, 200, 160)).toBe(0);
  });
});

describe("isBlueDominantShadowPixel", () => {
  it("keeps routing and assistant shadow checks on the same pixel predicate", () => {
    expect(isBlueDominantShadowPixel(70, 81, 102)).toBe(true);
    expect(isBlueDominantShadowPixel(230, 230, 230)).toBe(false);
    expect(isBlueDominantShadowPixel(151, 151, 151)).toBe(false);
  });
});

describe("pickClosestEntrance", () => {
  // Real positions from OSM and the published GTFS: the 7's platform point at
  // Grand Central (stop 723) and a rider bound for Café Grumpy on Lexington Av.
  const PLATFORM_7 = { lat: 40.751431, lon: -73.976041 };
  const CAFE: [number, number] = [-73.975716, 40.752144];
  // A terminal door into the Lexington Passage: 4 m from the café, 87 m from the train.
  const TERMINAL_DOOR = { lat: 40.752168, lon: -73.975677, kind: "entrance" };
  // The MTA street stair on the west sidewalk of Lex: 53 m from the café, 32 m from the train.
  const STREET_STAIR = { lat: 40.751721, lon: -73.976001, kind: "entrance" };

  it("counts the walk from the platform, not just the walk from the door", () => {
    // On the street leg alone the terminal door wins by 49 m; the whole trip
    // through the stair is 7 m shorter.
    const pick = pickClosestEntrance(CAFE, PLATFORM_7, [TERMINAL_DOOR, STREET_STAIR], haversineMeters);
    expect(pick).toEqual({ lat: STREET_STAIR.lat, lon: STREET_STAIR.lon });
  });

  it("still takes a door nearer the destination when the platform is equidistant", () => {
    const platform = { lat: 40.75, lon: -73.98 };
    const north = { lat: 40.7505, lon: -73.98, kind: "entrance" };
    const south = { lat: 40.7495, lon: -73.98, kind: "entrance" };
    const pick = pickClosestEntrance([-73.98, 40.752], platform, [south, north], haversineMeters);
    expect(pick).toEqual({ lat: north.lat, lon: north.lon });
  });

  it("prefers any real door to the station centroid", () => {
    // The centroid is the platform, so it would always win on distance alone.
    const centroid = { ...PLATFORM_7, kind: "station" };
    const pick = pickClosestEntrance(CAFE, PLATFORM_7, [centroid, TERMINAL_DOOR], haversineMeters);
    expect(pick).toEqual({ lat: TERMINAL_DOOR.lat, lon: TERMINAL_DOOR.lon });
  });
});
