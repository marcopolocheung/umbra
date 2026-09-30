import { describe, expect, it } from "vitest";
import { BASEMAP_PALETTES } from "../../basemapTheme";
import { isBlueDominantShadowPixel } from "../../shadowSampling";
import { shadowPixelAt } from "../../shadowField/__tests__/agreement/harness";
import { TARGET_GROUND_RES_M } from "../canopyCog";
import {
  CANOPY_FILL_OPACITY,
  CANOPY_FILL_RGB,
  CANOPY_PAINT_MIN_HEIGHT_M,
  CORRIDOR_GROUND_RES_M,
  imageryAt,
  paintPatches,
  readViewport,
  targetGroundResFor,
  viewportReads,
} from "../canopyPaint";
import { type CanopyPatch, createCanopyTileStore } from "../canopyTileStore";
import type { CanopyTileHandle, CanopyTileSource } from "../cogTileSource";
import {
  CANOPY_TILE_ZOOM,
  type LonLatBbox,
  type MercatorBbox,
  type OverviewCandidate,
  quadkeyFor,
  quadkeysForBbox,
  tileXYForQuadkey,
} from "../tiles";

type Rgb = readonly [number, number, number];

// ─── Invariant #5 ─────────────────────────────────────────────────────────────

/**
 * The basemap surfaces the fill can land on (R4's day and night palettes), as RGB.
 *
 * Only what is drawn *beneath* the fill: it goes in under the style's first water
 * layer, so water, roads and buildings cover it and never mix with it.
 */
const SURFACES: Record<string, Rgb> = Object.fromEntries(
  (["day", "night"] as const).flatMap((theme) =>
    (["land", "landuse", "field", "wood"] as const).map((role) => {
      const hex = BASEMAP_PALETTES[theme][role];
      return [`${theme} ${role}`, [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb];
    })
  )
);

/** The renderer's shadow colour runs from dawn (0) to the day's highest sun (1). */
const SUN_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];
const OPACITIES = [0.15, CANOPY_FILL_OPACITY, 0.8, 1];

/** The fill over a surface, rounded as an 8-bit framebuffer rounds it. */
const underFill = (surface: Rgb, opacity: number): Rgb =>
  surface.map((c, i) => Math.round(CANOPY_FILL_RGB[i] * opacity + c * (1 - opacity))) as unknown as Rgb;

const detectedAsShadow = (rgb: Rgb) => isBlueDominantShadowPixel(rgb[0], rgb[1], rgb[2]);

describe("the canopy fill and the shadow predicate (invariant #5)", () => {
  it("keeps shadow cast on solid fill detectable, from dawn to the highest sun", () => {
    // The property the colour was chosen for. Compositing is linear and each of the
    // predicate's tests is a half-space, so this one fact carries every opacity and
    // every surface below it — the next test checks that instead of trusting it.
    for (const t of SUN_FRACTIONS) {
      expect({ t, detected: detectedAsShadow(shadowPixelAt(t, CANOPY_FILL_RGB)) }).toEqual({
        t,
        detected: true,
      });
    }
  });

  it("never loses a shadow the predicate already saw, over any surface, at any fill opacity", () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      for (const t of SUN_FRACTIONS) {
        if (!detectedAsShadow(shadowPixelAt(t, surface))) continue;
        for (const opacity of OPACITIES) {
          const shadowed = shadowPixelAt(t, underFill(surface, opacity));
          expect({ name, t, opacity, detected: detectedAsShadow(shadowed) }).toEqual({
            name,
            t,
            opacity,
            detected: true,
          });
        }
      }
    }
  });

  it("never makes sunlit canopy read as shadow", () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      for (const opacity of OPACITIES) {
        expect({ name, opacity, detected: detectedAsShadow(underFill(surface, opacity)) }).toEqual({
          name,
          opacity,
          detected: false,
        });
      }
    }
  });

  it("moves a shadow's anti-aliased edge by under a fifth of a pixel", () => {
    // The convexity argument covers pixels a shadow covers fully. On the rim, where
    // the renderer's supersampling leaves a pixel part-covered, the fill shifts the
    // coverage at which that pixel starts to count as shadow — inward at a low sun,
    // outward at a high one. Bound it rather than claim it away.
    const firstCounted = (t: number, surface: Rgb) => {
      for (let step = 0; step <= 200; step++) {
        if (detectedAsShadow(shadowPixelAt(t, surface, step / 200))) return step / 200;
      }
      return null;
    };
    for (const [name, surface] of Object.entries(SURFACES)) {
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const bare = firstCounted(t, surface);
        const filled = firstCounted(t, underFill(surface, CANOPY_FILL_OPACITY));
        if (bare === null || filled === null) continue;
        expect({ name, t, shift: Math.abs(filled - bare) < 0.2 }).toEqual({ name, t, shift: true });
      }
    }
  });
});

// ─── Painting ─────────────────────────────────────────────────────────────────

/** A one-row patch over a small box, for the painting rules alone. */
function rowPatch(heights: number[], valid: number[] | null = null): CanopyPatch {
  return {
    heights: Uint8Array.from(heights),
    valid: valid ? Uint8Array.from(valid) : null,
    width: heights.length,
    height: 1,
    bbox: [-3.704, 40.4168, -3.704 + heights.length * 1e-5, 40.41681],
    metresPerPixel: 1,
    overviewIndex: 0,
    quadkeys: ["0331110121"],
  };
}

const alphas = (rgba: Uint8ClampedArray) => Array.from(rgba.filter((_, i) => i % 4 === 3));

describe("paintPatches", () => {
  it("paints canopy at and above the threshold, and nothing below it", () => {
    const below = CANOPY_PAINT_MIN_HEIGHT_M - 1;
    const image = paintPatches([rowPatch([0, below, CANOPY_PAINT_MIN_HEIGHT_M, 30])]);
    expect(alphas(image?.rgba ?? new Uint8ClampedArray())).toEqual([0, 0, 255, 255]);
  });

  it("does not paint nodata, however tall the stamp under it", () => {
    const image = paintPatches([rowPatch([30, 30, 30], [1, 0, 1])]);
    expect(alphas(image?.rgba ?? new Uint8ClampedArray())).toEqual([255, 0, 255]);
  });

  it("counts what it painted, so a view with no canopy in it can say so", () => {
    expect(paintPatches([rowPatch([0, 30, 30], [1, 1, 0])])?.painted).toBe(1);
    expect(paintPatches([rowPatch([0, 1, 2])])?.painted).toBe(0);
  });

  it("paints nothing when no quadkey answered", () => {
    expect(paintPatches([])).toBeNull();
  });
});

// ─── Reading the viewport ─────────────────────────────────────────────────────

const WORLD_SPAN = 2 * Math.PI * 6378137;
const TILE_SPAN = WORLD_SPAN / 2 ** CANOPY_TILE_ZOOM;
const LEVELS: OverviewCandidate[] = [{ index: 0, width: 4096 }];
const BLOCK = 256;

/** A corner near Madrid where four published quadkeys meet. */
const SEAM: [number, number] = [-3.8671875, 40.4469470596005];

/** Height varies with the world pixel, so a misplaced tile shows up as a wrong image. */
const heightAt = (worldX: number, worldY: number) => (worldX * 7 + worldY * 3) % 11;

/**
 * A fake COG host. `unpublished` quadkeys 404, as open ocean does on `source.coop`;
 * `gate`, when given, holds every range read open until it resolves.
 */
function fakeSource(unpublished: Set<string> = new Set(), gate?: Promise<void>) {
  const opened: string[] = [];
  const fetchSignals: (AbortSignal | undefined)[] = [];
  const source: CanopyTileSource = {
    async open(quadkey) {
      opened.push(quadkey);
      if (unpublished.has(quadkey)) throw new Error(`404 chm/${quadkey}.tif`);
      const [tileX, tileY] = tileXYForQuadkey(quadkey);
      const tileBbox: MercatorBbox = [
        -WORLD_SPAN / 2 + tileX * TILE_SPAN,
        WORLD_SPAN / 2 - (tileY + 1) * TILE_SPAN,
        -WORLD_SPAN / 2 + (tileX + 1) * TILE_SPAN,
        WORLD_SPAN / 2 - tileY * TILE_SPAN,
      ];
      const handle: CanopyTileHandle = {
        quadkey,
        tileBbox,
        levels: LEVELS,
        async grid() {
          return { width: 4096, height: 4096, blockSize: BLOCK };
        },
        async read(_level, window, signal) {
          fetchSignals.push(signal);
          if (gate) await gate;
          const width = window[2] - window[0];
          const height = window[3] - window[1];
          const heights = new Uint8Array(width * height);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              heights[y * width + x] = heightAt(tileX * 4096 + window[0] + x, tileY * 4096 + window[1] + y);
            }
          }
          return { heights, valid: null };
        },
      };
      return handle;
    },
  };
  return { source, opened, fetchSignals };
}

function storeOver(unpublished?: Set<string>, gate?: Promise<void>) {
  const fake = fakeSource(unpublished, gate);
  const store = createCanopyTileStore({ source: fake.source, sleep: async () => {} });
  return { ...fake, store };
}

function boxAround([lon, lat]: [number, number], sizeM: number): LonLatBbox {
  const dLat = sizeM / 2 / 111_320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

describe("reading the viewport", () => {
  const overSeam = boxAround(SEAM, 1200);

  it("splits a viewport over a quadkey corner into one read per quadkey, each inside its own", () => {
    const reads = viewportReads(overSeam);
    expect(reads.map((r) => r.quadkey).sort()).toEqual(quadkeysForBbox(overSeam).sort());
    expect(reads).toHaveLength(4);
    for (const { quadkey, aoi } of reads) {
      expect(quadkeysForBbox(aoi)).toEqual([quadkey]);
    }
  });

  it("paints the same image one quadkey at a time as one stitched read does", async () => {
    const { store } = storeOver();
    const perQuadkey = paintPatches(await readViewport(store, overSeam));
    const stitched = paintPatches([
      await store.read(overSeam, { targetGroundRes: targetGroundResFor(overSeam) }),
    ]);

    expect(perQuadkey?.width).toBe(stitched?.width);
    expect(perQuadkey?.height).toBe(stitched?.height);
    expect(perQuadkey?.bbox).toEqual(stitched?.bbox);
    expect(perQuadkey?.rgba).toEqual(stitched?.rgba);
  });

  it("still paints the published quadkeys when one beside them is not published (#289)", async () => {
    const missing = quadkeyFor(SEAM[0] + 0.001, SEAM[1] + 0.001);
    const { store, opened } = storeOver(new Set([missing]));

    // The store alone fails the whole area: the right default for a route corridor.
    await expect(store.read(overSeam)).rejects.toThrow(missing);

    const patches = await readViewport(store, overSeam);
    expect(patches.flatMap((p) => p.quadkeys).sort()).toEqual(
      quadkeysForBbox(overSeam).filter((q) => q !== missing).sort()
    );
    // No read for a published quadkey reached across into the missing one.
    expect(patches.every((p) => !p.quadkeys.includes(missing))).toBe(true);
    expect(opened.filter((q) => q === missing).length).toBeGreaterThan(0);
  });

  it("cancels the fetch when superseded, and rejects so a stale read cannot repaint", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, fetchSignals } = storeOver(undefined, gate);
    const controller = new AbortController();
    const pending = readViewport(store, overSeam, controller.signal);
    while (fetchSignals.length === 0) await new Promise((r) => setTimeout(r, 0));

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // The store cancelled the range reads themselves — nobody else was waiting.
    expect(fetchSignals.every((signal) => signal?.aborted)).toBe(true);
    release();
  });
});

describe("targetGroundResFor", () => {
  it("reads a street-sized view at the route corridor's resolution, so the two share blocks", () => {
    expect(CORRIDOR_GROUND_RES_M).toBe(TARGET_GROUND_RES_M);
    expect(targetGroundResFor(boxAround(SEAM, 1500))).toBe(TARGET_GROUND_RES_M);
  });

  it("reads a wide view coarser, keeping its image near a thousand pixels across", () => {
    const res = targetGroundResFor(boxAround(SEAM, 12_000));
    expect(res).toBeGreaterThan(TARGET_GROUND_RES_M);
    expect(12_000 / res).toBeLessThanOrEqual(1024 + 1);
  });
});

// ─── Honesty ──────────────────────────────────────────────────────────────────

describe("imageryAt", () => {
  it("flags Madrid's February imagery as leaf-off (#281)", () => {
    expect(imageryAt(-3.7038, 40.4168)).toEqual({ date: "2020-02-20", leafOff: true });
  });

  it("does not flag Kent's August imagery, or Singapore's, where nothing drops its leaves", () => {
    expect(imageryAt(-122.2348, 47.3809)?.leafOff).toBe(false);
    expect(imageryAt(103.851, 1.284)?.leafOff).toBe(false);
  });

  it("says nothing where this build has no date, rather than assuming one", () => {
    expect(imageryAt(2.3522, 48.8566)).toBeNull();
  });
});
