import type { Page } from "@playwright/test";
import { isBlueDominantShadowPixel } from "../../app/lib/shadowSampling";

/** Flat [r, g, b, r, g, b, …] read back from the live map canvas. */
export async function sampleMapCanvas(page: Page, step: number): Promise<number[]> {
  return page.evaluate((sampleStep) => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.maplibregl-canvas");
    if (!canvas) throw new Error("MapLibre canvas not found");
    // Readable only because of invariant #3, preserveDrawingBuffer: true.
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
    const out: number[] = [];
    for (let y = 0; y < scratch.height; y += sampleStep) {
      for (let x = 0; x < scratch.width; x += sampleStep) {
        const i = (y * scratch.width + x) * 4;
        out.push(data[i], data[i + 1], data[i + 2]);
      }
    }
    return out;
  }, step);
}

/** The app's own shadow predicate, imported rather than restated (invariant #5). */
export function shadowMask(samples: number[]): boolean[] {
  const mask: boolean[] = [];
  for (let i = 0; i < samples.length; i += 3) {
    mask.push(isBlueDominantShadowPixel(samples[i], samples[i + 1], samples[i + 2]));
  }
  return mask;
}

export const shadowedFraction = (mask: boolean[]) => mask.filter(Boolean).length / mask.length;

/**
 * Fraction of samples whose shadowed state differs between two frames. Throws on a
 * length mismatch: a resized canvas would otherwise read as "everything changed"
 * and pass the shadows-moved assertion for the wrong reason.
 */
export function maskDiff(before: boolean[], after: boolean[]): number {
  if (before.length !== after.length) {
    throw new Error(`canvas sample count changed: ${before.length} then ${after.length}`);
  }
  return after.filter((shadowed, i) => shadowed !== before[i]).length / after.length;
}

/**
 * Pixels of the nav route line. By day (every scenario here) R4b paints it opaque
 * `--color-map-day-route` #1B1512 over a paper casing: a warm near-black nothing else
 * on either basemap reaches. The basemap's darkest ink is #3B322B, and a shadowed label
 * turns blue, (18, 27, 46), which the warm test rejects. Counted in-page at full
 * resolution: the line is 4 px wide, so the shadow sampling grid would step over it.
 */
export async function countRouteLinePixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.maplibregl-canvas");
    if (!canvas) throw new Error("MapLibre canvas not found");
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r <= 40 && g <= 40 && b <= 40 && Math.abs(r - b) <= 12) count++;
    }
    return count;
  });
}

/**
 * Pixels of the fixture transit line's colour (#FF00FF). Nothing else on the
 * map is magenta, so a non-zero count means `buildTrainDrawData`'s polylines
 * actually reached the canvas — which is the half of the transit feature that
 * no unit test can see.
 */
export async function countTransitLinePixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.maplibregl-canvas");
    if (!canvas) throw new Error("MapLibre canvas not found");
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 190 && data[i + 1] < 90 && data[i + 2] > 190) count++;
    }
    return count;
  });
}
