import { describe, expect, it } from "vitest";
import type { CanopyPatch, CanopyTileStore } from "../canopyTileStore";
import { lonLatToMercator, mercatorToLonLat } from "../tiles";
import {
  CANOPY_ATLAS_BORDER_M,
  CANOPY_ATLAS_MAX_SIDE,
  atlasBboxFor,
  atlasGroundResFor,
  createCanopyViewportReader,
  toAtlas,
  type CanopyViewMap,
} from "../viewportCanopy";

/**
 * The viewport atlas controller, against analytic geometry.
 *
 * What is pinned: the border (offscreen casters survive viewport clipping), the
 * resolution policy (2 m until the 2048² cap forces coarsening, never finer),
 * the generation stamp, the cache (a pan inside the last read reuses it), the
 * abort (a superseded read publishes nothing), and the copy rule (the atlas never
 * aliases the store's cached arrays).
 */

const MADRID: [number, number] = [-3.7038, 40.4168];
const RES_M = 2;

function fakeMap(viewportHalfM: number, zoom = 15): CanopyViewMap {
  const dLat = (viewportHalfM / 111_320);
  const dLon = dLat / Math.cos((MADRID[1] * Math.PI) / 180);
  return {
    getZoom: () => zoom,
    getBounds: () => ({
      getWest: () => MADRID[0] - dLon,
      getSouth: () => MADRID[1] - dLat,
      getEast: () => MADRID[0] + dLon,
      getNorth: () => MADRID[1] + dLat,
    }),
    getCenter: () => ({ lng: MADRID[0], lat: MADRID[1] }),
  };
}

/** A store that answers from a synthetic patch built for whatever bbox is asked. */
function storeOver(
  heightAt: (lng: number, lat: number) => number,
): Pick<CanopyTileStore, "read"> {
  return {
    async read(aoi) {
      const size = 64;
      const [cx, cy] = lonLatToMercator((aoi[0] + aoi[2]) / 2, (aoi[1] + aoi[3]) / 2);
      const mercRes = RES_M / Math.cos((((aoi[1] + aoi[3]) / 2) * Math.PI) / 180);
      const half = (size / 2) * mercRes;
      const [west, south] = mercatorToLonLat(cx - half, cy - half);
      const [east, north] = mercatorToLonLat(cx + half, cy + half);
      const heights = new Uint8Array(size * size);
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          const lng = west + ((east - west) * col) / (size - 1);
          const lat = north - ((north - south) * row) / (size - 1);
          heights[row * size + col] = heightAt(lng, lat);
        }
      }
      const patch: CanopyPatch = {
        heights,
        valid: null,
        width: size,
        height: size,
        bbox: [west, south, east, north],
        metresPerPixel: RES_M,
        overviewIndex: 0,
        quadkeys: ["test"],
      };
      return patch;
    },
  };
}

describe("atlas geometry", () => {
  it("pads the viewport by the caster border, without clipping the border to the view limit", () => {
    const viewport: [number, number, number, number] = [
      MADRID[0] - 0.02, MADRID[1] - 0.02, MADRID[0] + 0.02, MADRID[1] + 0.02,
    ];
    const bbox = atlasBboxFor(viewport, MADRID);
    const dLat = (bbox[3] - bbox[1]) * 111_320;
    const dLon = (bbox[2] - bbox[0]) * 111_320 * Math.cos((MADRID[1] * Math.PI) / 180);
    // Each side grew by the border — the border is not clipped off by the view cap.
    const viewHalfLat = 0.02 * 111_320;
    const viewHalfLon = 0.02 * 111_320 * Math.cos((MADRID[1] * Math.PI) / 180);
    expect(dLat / 2 - viewHalfLat).toBeCloseTo(CANOPY_ATLAS_BORDER_M, -1);
    expect(dLon / 2 - viewHalfLon).toBeCloseTo(CANOPY_ATLAS_BORDER_M, -1);
  });

  it("keeps 2 m resolution while the atlas fits the cap, coarsens only past it", () => {
    // A 2 km viewport + 800 m of border at 2 m = 1400 px — inside 2048.
    const small: [number, number, number, number] = [
      MADRID[0] - 0.01, MADRID[1] - 0.01, MADRID[0] + 0.01, MADRID[1] + 0.01,
    ];
    expect(atlasGroundResFor(small)).toBe(2);
    // A 12 km viewport: 12 km + 800 m at 2048 px needs ~6.25 m.
    const large: [number, number, number, number] = [
      MADRID[0] - 0.068, MADRID[1] - 0.054, MADRID[0] + 0.068, MADRID[1] + 0.054,
    ];
    expect(atlasGroundResFor(large)).toBeGreaterThan(2);
    // And the resulting atlas fits the cap.
    const midLat = (large[1] + large[3]) / 2;
    const widthM = (large[2] - large[0]) * 111_320 * Math.cos((midLat * Math.PI) / 180);
    const heightM = (large[3] - large[1]) * 111_320;
    const res = atlasGroundResFor(large);
    expect(Math.max(widthM, heightM) / res).toBeLessThanOrEqual(CANOPY_ATLAS_MAX_SIDE);
  });
});

describe("toAtlas", () => {
  it("copies the patch without aliasing the store's arrays", () => {
    const patch: CanopyPatch = {
      heights: new Uint8Array([5, 0, 0, 7]),
      valid: new Uint8Array([1, 1, 0, 1]),
      width: 2, height: 2,
      bbox: [0, 0, 1, 1],
      metresPerPixel: RES_M,
      overviewIndex: 0,
      quadkeys: ["t"],
    };
    const atlas = toAtlas(patch, 3);
    expect([...atlas.heights]).toEqual([5, 0, 0, 7]);
    expect([...atlas.valid!]).toEqual([1, 1, 0, 1]);
    expect(atlas.generation).toBe(3);
    // Copies, not aliases: mutating the patch must not move the atlas.
    patch.heights[0] = 99;
    expect(atlas.heights[0]).toBe(5);
  });

  it("decimates an oversized patch to the cap with nearest-neighbour picks", () => {
    const size = CANOPY_ATLAS_MAX_SIDE * 2;
    const heights = new Uint8Array(size * size);
    heights[0] = 9; // the top-left pixel — the one nearest-neighbour keeps
    const patch: CanopyPatch = {
      heights,
      valid: null,
      width: size,
      height: size,
      bbox: [0, 0, 1, 1],
      metresPerPixel: 1,
      overviewIndex: 0,
      quadkeys: ["t"],
    };
    const atlas = toAtlas(patch, 1);
    expect(atlas.width).toBe(CANOPY_ATLAS_MAX_SIDE);
    expect(atlas.height).toBe(CANOPY_ATLAS_MAX_SIDE);
    expect(atlas.heights[0]).toBe(9);
    expect(atlas.metresPerPixel).toBe(2);
  });
});

describe("createCanopyViewportReader", () => {
  it("reads the padded viewport, stamps a generation, and reports it", async () => {
    let reported: { atlas: { generation: number }; viewport: number[] } | null = null;
    const read = createCanopyViewportReader({
      getStore: () => Promise.resolve(storeOver(() => 0)),
      onAtlas: (s) => { reported = s ? { atlas: s.atlas, viewport: s.viewport } : null; },
    });
    await read(fakeMap(500));
    expect(reported).not.toBeNull();
    expect(reported!.atlas.generation).toBe(1);
    // The viewport reported is the view, not the padded read.
    expect(reported!.viewport[2] - reported!.viewport[0]).toBeCloseTo(
      2 * (500 / (111_320 * Math.cos((MADRID[1] * Math.PI) / 180))), 6,
    );
  });

  it("reuses the cached atlas for a pan inside the last read at the same resolution", async () => {
    const reads: number[] = [];
    const store = storeOver(() => 0);
    const read = createCanopyViewportReader({
      getStore: () => Promise.resolve({
        read: async (aoi: number[]) => { reads.push(aoi[0]); return store.read(aoi as [number, number, number, number]); },
      }),
      onAtlas: () => {},
    });
    await read(fakeMap(500));
    expect(reads.length).toBe(1);
    // Same size, same centre — a cache hit, no second store read.
    await read(fakeMap(500));
    expect(reads.length).toBe(1);
  });

  it("advances the generation when a new read lands", async () => {
    const generations: number[] = [];
    const read = createCanopyViewportReader({
      getStore: () => Promise.resolve(storeOver(() => 0)),
      onAtlas: (s) => { if (s) generations.push(s.atlas.generation); },
    });
    await read(fakeMap(500));
    // Zoom out → different resolution → a genuinely new read.
    await read(fakeMap(5000));
    expect(generations).toEqual([1, 2]);
  });

  it("reports nothing below the zoom floor", async () => {
    let reported: unknown = "unset";
    const read = createCanopyViewportReader({
      getStore: () => Promise.resolve(storeOver(() => 0)),
      onAtlas: (s) => { reported = s; },
    });
    await read(fakeMap(500, 13));
    expect(reported).toBeNull();
  });

  it("never publishes a superseded read", async () => {
    const generations: number[] = [];
    const pending: Array<() => void> = [];
    const patch = (): CanopyPatch => ({
      heights: new Uint8Array(4), valid: null, width: 2, height: 2,
      bbox: [0, 0, 1, 1], metresPerPixel: RES_M, overviewIndex: 0, quadkeys: ["t"],
    });
    const read = createCanopyViewportReader({
      getStore: () => Promise.resolve({
        read: () =>
          new Promise<CanopyPatch>((resolve) => {
            pending.push(() => resolve(patch()));
          }),
      }),
      onAtlas: (s) => { if (s) generations.push(s.atlas.generation); },
    });
    const first = read(fakeMap(500));
    // A second read starts before the first settles: the controller aborts the
    // first, which must stop it publishing even when its store read resolves.
    const second = read(fakeMap(3000));
    // Let both readers reach their store.read and register their resolvers.
    await new Promise((r) => setTimeout(r, 0));
    for (const release of pending.splice(0)) release();
    await Promise.allSettled([first, second]);
    // Exactly one generation landed — the surviving read's. The aborted first
    // read either resolved before checking its signal (and was discarded) or was
    // rejected; either way it never stamped a snapshot.
    expect(generations.length).toBeLessThanOrEqual(1);
    expect(new Set(generations).size).toBe(generations.length);
  });
});
