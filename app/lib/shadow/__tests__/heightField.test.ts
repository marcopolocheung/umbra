import { describe, expect, it } from "vitest";
import {
  MAX_CEILING_FIELD_SCALE,
  SHADOW_HEIGHT_BIAS_M,
  ceilingFieldScale,
  normalizedCeilingLift,
  normalizedShadowHeightBias,
} from "../heightField";

/** What the RGBA8 height field could represent, one 1/255 step per level. */
function quantize8(value: number): number {
  return Math.round(value * (2 ** 8 - 1)) / (2 ** 8 - 1);
}

/** What the DEPTH_COMPONENT24 ceiling texture represents. */
function quantize24(value: number): number {
  return Math.round(value * (2 ** 24 - 1)) / (2 ** 24 - 1);
}

/** The normalized slack the shaders used before the tolerance became metric. */
const LEGACY_NORMALIZED_BIAS = 0.004;

/**
 * The regression: a 20 m rooftop object on a 17 m roof, in a scene whose tallest
 * cached building is 541 m. Both shaders treat "ceiling <= surface + bias" as the
 * surface shading itself and drop the shadow, so the caster has to survive both
 * quantization and the bias to be drawn at all.
 */
const MAX_H_M = 541;
const CASTER_M = 20;
const RECEIVER_M = 17;

describe("normalizedShadowHeightBias", () => {
  it("loses the rooftop shadow under the old 8-bit field and normalized bias", () => {
    const ceiling = quantize8(CASTER_M / MAX_H_M);
    const surface = RECEIVER_M / MAX_H_M;

    // 3 m of real clearance, erased: 8 bits over 541 m is a ~2.1 m step, and the
    // fixed 0.004 was another ~2.2 m on top of it.
    expect(ceiling).toBeLessThanOrEqual(surface + LEGACY_NORMALIZED_BIAS);
  });

  it("keeps the rooftop shadow under the 24-bit field and the metric bias", () => {
    const ceiling = quantize24(CASTER_M / MAX_H_M);
    const surface = RECEIVER_M / MAX_H_M;

    expect(ceiling).toBeGreaterThan(surface + normalizedShadowHeightBias(MAX_H_M));
  });

  it("still classifies an equal-height caster and receiver as self-shadow", () => {
    const ceiling = quantize24(CASTER_M / MAX_H_M);
    const surface = CASTER_M / MAX_H_M;

    expect(ceiling).toBeLessThanOrEqual(surface + normalizedShadowHeightBias(MAX_H_M));
  });

  it("resolves a 10 cm step, which the old scheme could not", () => {
    const ceiling = quantize24((RECEIVER_M + 0.1) / MAX_H_M);
    const surface = RECEIVER_M / MAX_H_M;

    expect(ceiling).toBeGreaterThan(surface + normalizedShadowHeightBias(MAX_H_M));
    expect(quantize8((RECEIVER_M + 0.1) / MAX_H_M)).toBeLessThanOrEqual(
      surface + LEGACY_NORMALIZED_BIAS,
    );
  });

  it.each([1, 20, 541, 1_000])(
    "represents five centimetres when the tallest cached building is %s m",
    (maxHeightM) => {
      expect(normalizedShadowHeightBias(maxHeightM) * maxHeightM).toBeCloseTo(
        SHADOW_HEIGHT_BIAS_M,
        12,
      );
    },
  );

  it("tightens as the tallest cached building grows, unlike a fixed normalized bias", () => {
    // The old constant meant ~0.08 m of slack in a low-rise scene and ~2.2 m next
    // to a skyscraper; the metric one is 0.05 m in both.
    expect(normalizedShadowHeightBias(20)).toBeGreaterThan(normalizedShadowHeightBias(541));
    expect(LEGACY_NORMALIZED_BIAS * 541).toBeGreaterThan(2);
    expect(normalizedShadowHeightBias(541) * 541).toBeCloseTo(0.05, 12);
  });
});

/**
 * The wall pass samples the ceiling field a metre or two *toward the sun* to escape
 * its own footprint, where the field saturates at the caster's own roofline. Moving
 * toward the sun means closer to every caster, so the sampled ceiling rises — and
 * the threshold it is compared against has to rise by the same amount or the wall
 * shadows higher than the ground shadow at its base says it should.
 */
describe("normalizedCeilingLift", () => {
  /**
   * One caster of height `H`, footprint at `x <= 0`, with `x` measured along the
   * ground *away* from the sun. Past the footprint the ceiling falls at `tan(alt)`;
   * over it the field saturates at the roofline — the near cap the nudge escapes.
   */
  const H = 80;
  const ceilingAt = (x: number, alt: number): number =>
    x <= 0 ? H : Math.min(H, Math.max(0, H - x * Math.tan(alt)));

  const ALTS = [10, 20, 33, 45, 70].map((deg) => (deg * Math.PI) / 180);
  /** The two nudge constants and their diagonal sum. */
  const OFFSETS = [1.5, 2.25, 3];
  /** Fractions of the shadow's length to place the surface point at. */
  const FRACTIONS = [0.2, 0.5, 0.8];

  /** How Pass E decides, having sampled the field `d` metres sunward of `x0`. */
  function shadowedAfterNudge(x0: number, d: number, h: number, alt: number, lift: number) {
    return h / MAX_H_M + lift <= ceilingAt(x0 - d, alt) / MAX_H_M;
  }

  /** How the un-nudged ground pass decides at that same spot. */
  function shadowedAtSurface(x0: number, h: number, alt: number) {
    return h <= ceilingAt(x0, alt);
  }

  /** Surface heights either side of the true terminator, none of them on it. */
  function probeHeights(ceiling: number, delta: number): number[] {
    return [ceiling - 1.5 * delta, ceiling - 0.5 * delta, ceiling + 0.5 * delta, ceiling + 1.5 * delta];
  }

  it("makes the nudged sample decide exactly what the un-nudged one would", () => {
    for (const alt of ALTS) {
      for (const d of OFFSETS) {
        const lift = normalizedCeilingLift(d, alt, MAX_H_M);
        for (const fraction of FRACTIONS) {
          const x0 = (fraction * H) / Math.tan(alt);
          if (x0 < d) continue; // the near cap, covered by its own test below
          const ceiling = ceilingAt(x0, alt);
          for (const h of probeHeights(ceiling, d * Math.tan(alt))) {
            expect(shadowedAfterNudge(x0, d, h, alt, lift)).toBe(shadowedAtSurface(x0, h, alt));
          }
        }
      }
    }
  });

  it("over-shadows the wall without the lift, by the sunward step's worth of height", () => {
    const alt = (33 * Math.PI) / 180;
    const d = 1.5;
    const x0 = (0.5 * H) / Math.tan(alt);
    // A surface half a step above the true terminator: lit on the ground, shadowed on
    // the wall. This is the step a shadow crossing from street to wall shows today.
    const h = ceilingAt(x0, alt) + 0.5 * d * Math.tan(alt);

    expect(shadowedAtSurface(x0, h, alt)).toBe(false);
    expect(shadowedAfterNudge(x0, d, h, alt, 0)).toBe(true);
    expect(shadowedAfterNudge(x0, d, h, alt, normalizedCeilingLift(d, alt, MAX_H_M))).toBe(false);
  });

  it("bounds the residual to the step's height where the nudge stays inside the footprint", () => {
    for (const alt of ALTS) {
      for (const d of OFFSETS) {
        const lift = normalizedCeilingLift(d, alt, MAX_H_M);
        for (const x0 of [0, 0.25 * d, 0.75 * d]) {
          const ceiling = ceilingAt(x0, alt);
          for (const h of probeHeights(ceiling, d * Math.tan(alt))) {
            const nudged = shadowedAfterNudge(x0, d, h, alt, lift);
            const truth = shadowedAtSurface(x0, h, alt);
            if (nudged === truth) continue;
            // Under-shading only — never the lit-to-shadowed direction — and confined
            // to a band one sunward step tall under the true terminator.
            expect([nudged, truth]).toEqual([false, true]);
            expect(ceiling - h).toBeLessThanOrEqual(d * Math.tan(alt));
          }
        }
      }
    }
  });

  it("vanishes with the sun on the horizon and grows as the sun climbs", () => {
    expect(normalizedCeilingLift(1.5, 0, MAX_H_M)).toBe(0);
    const lifts = ALTS.map((alt) => normalizedCeilingLift(1.5, alt, MAX_H_M));
    for (const [i, lift] of lifts.entries()) {
      expect(lift).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(lift).toBeGreaterThan(lifts[i - 1]);
    }
  });

  it("dwarfs the height tolerance the same shaders already model in metres", () => {
    const alt = (33 * Math.PI) / 180;
    for (const d of [1.5, 3]) {
      expect(normalizedCeilingLift(d, alt, MAX_H_M)).toBeGreaterThan(
        10 * normalizedShadowHeightBias(MAX_H_M),
      );
    }
  });
});

describe("ceilingFieldScale", () => {
  /**
   * A pinhole camera `distance` above the origin, tilted back by `pitchRad` about
   * the x axis — MapLibre's camera in the small. Returned column-major, so
   * `m[col * 4 + row]`, which is how the mainMatrix reaches the shaders.
   */
  function cameraMatrix(pitchRad: number, distance: number): number[] {
    const near = distance / 100;
    const far = distance * 100;
    const f = 1 / Math.tan(Math.PI / 6); // 60 degree vertical field of view
    const c = Math.cos(pitchRad);
    const s = Math.sin(pitchRad);
    // View: tilt the world back, then push it `distance` down the camera's -z.
    const view = [
      [1, 0, 0, 0],
      [0, c, s, 0],
      [0, -s, c, -distance],
      [0, 0, 0, 1],
    ];
    const proj = [
      [f, 0, 0, 0],
      [0, f, 0, 0],
      [0, 0, (far + near) / (near - far), (2 * far * near) / (near - far)],
      [0, 0, -1, 0],
    ];
    const m: number[] = [];
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += proj[row][k] * view[k][col];
        m.push(sum);
      }
    }
    return m;
  }

  /** NDC of a world point, or null when it sits behind the camera. */
  function project(m: number[], x: number, y: number, z: number): [number, number] | null {
    const clip = [0, 1, 3].map(
      (row) => m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row],
    );
    if (clip[2] <= 1e-9) return null;
    return [clip[0] / clip[2], clip[1] / clip[2]];
  }

  const DISTANCE = 1000;
  const MAX_H = 120;

  /**
   * The contract, stated as the shaders use it: every fragment that reaches the
   * screen must find its own footprint inside the widened field. Walks a grid of
   * ground positions, keeps the ones whose roofline is on screen, and checks where
   * the ground under them lands.
   */
  function worstFootprintReach(m: number[]): number {
    let worst = 0;
    for (let x = -4000; x <= 4000; x += 25) {
      for (let y = -4000; y <= 4000; y += 25) {
        const top = project(m, x, y, MAX_H);
        if (!top || Math.abs(top[0]) > 1 || Math.abs(top[1]) > 1) continue;
        const foot = project(m, x, y, 0);
        if (!foot) return Number.POSITIVE_INFINITY;
        worst = Math.max(worst, Math.abs(foot[0]), Math.abs(foot[1]));
      }
    }
    return worst;
  }

  it("asks for no widening from a camera looking straight down", () => {
    // Looking down, a roof projects *outside* its own footprint, so the field
    // already covers everything and the scale must not cost any resolution.
    expect(ceilingFieldScale(cameraMatrix(0, DISTANCE), MAX_H)).toBe(1);
  });

  it("covers the footprint of every on-screen roofline once tilted", () => {
    for (const deg of [15, 30, 45, 55, 60]) {
      const m = cameraMatrix((deg * Math.PI) / 180, DISTANCE);
      const scale = ceilingFieldScale(m, MAX_H);
      const reach = worstFootprintReach(m);
      // The grid samples the interior, so it can only ever under-report the worst
      // corner the function solves for exactly. Coverage is the contract.
      expect(reach).toBeLessThanOrEqual(scale + 1e-6);
    }
  });

  it("does not spend resolution a gentle tilt has not asked for", () => {
    // Widening costs ground resolution one-for-one, so a 15 degree camera must not
    // pay anything like what a 60 degree one does.
    expect(ceilingFieldScale(cameraMatrix(Math.PI / 12, DISTANCE), MAX_H)).toBeLessThan(1.2);
    expect(ceilingFieldScale(cameraMatrix(Math.PI / 3, DISTANCE), MAX_H)).toBeGreaterThan(1.2);
  });

  it("shows the unwidened field really does miss those footprints", () => {
    // The bug this exists to fix: at 60 degrees the ground under a visible roof
    // leaves the viewport, the lookup falls outside the field, and Pass E's
    // `onScreen` guard forces the fragment lit.
    expect(worstFootprintReach(cameraMatrix(Math.PI / 3, DISTANCE))).toBeGreaterThan(1);
  });

  it("grows with the building height it has to reach back from", () => {
    const m = cameraMatrix(Math.PI / 3, DISTANCE);
    const scales = [0, 30, 60, 120, 240].map((h) => ceilingFieldScale(m, h));
    expect(scales[0]).toBe(1);
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1]);
    }
  });

  it("stays inside the cap however extreme the camera", () => {
    for (const deg of [70, 80, 85]) {
      const scale = ceilingFieldScale(cameraMatrix((deg * Math.PI) / 180, DISTANCE), 400);
      expect(scale).toBeLessThanOrEqual(MAX_CEILING_FIELD_SCALE);
      expect(scale).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves the field alone when there is nothing to solve", () => {
    // A singular matrix has no footprint homography, and a scene with no buildings
    // has no footprints to reach. Both leave the field exactly as it was.
    expect(ceilingFieldScale(new Array(16).fill(0), MAX_H)).toBe(1);
    expect(ceilingFieldScale(cameraMatrix(Math.PI / 3, DISTANCE), 0)).toBe(1);
  });
});
