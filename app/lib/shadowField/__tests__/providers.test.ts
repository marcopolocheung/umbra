import { describe, expect, it, vi } from "vitest";
import type { BuildingFootprint, CanopyFeature } from "../../overpass";
import {
  type BBox,
  LOW_CONFIDENCE,
  bboxAroundPoint,
  confidenceFor,
  createGeometryShadowField,
} from "../ShadowField";
import type { BuildingFeatureLike } from "../geometry";
import type {
  CanopyPatch,
  CanopyTileStore,
} from "../../canopyRaster/canopyTileStore";
import type { LonLatBbox } from "../../canopyRaster/tiles";
import {
  type TileMapLike,
  bboxRadiusM,
  createOverpassCanopyProvider,
  createOverpassPrismProvider,
  createRasterCanopyProvider,
  createShedProvider,
  createTilePrismProvider,
} from "../providers";
import type { ShedPermitResult } from "../../../services/sidewalkSheds";

const LAT = 40.4168;
const LNG = -3.7038;

function square(centreLng: number, centreLat: number, halfDeg: number): [number, number][] {
  return [
    [centreLng - halfDeg, centreLat - halfDeg],
    [centreLng + halfDeg, centreLat - halfDeg],
    [centreLng + halfDeg, centreLat + halfDeg],
    [centreLng - halfDeg, centreLat + halfDeg],
    [centreLng - halfDeg, centreLat - halfDeg],
  ];
}

function tileFeature(height: number): BuildingFeatureLike {
  return {
    properties: { render_height: height },
    geometry: { type: "Polygon", coordinates: [square(LNG, LAT, 0.0002)] },
  };
}

interface FakeMapOpts {
  zoom?: number;
  bounds?: BBox;
  features?: BuildingFeatureLike[];
}

function fakeMap(opts: FakeMapOpts = {}) {
  const bounds = opts.bounds ?? bboxAroundPoint(LNG, LAT, 2000);
  const querySourceFeatures = vi.fn(() => opts.features ?? [tileFeature(18)]);

  const map: TileMapLike = {
    getZoom: () => opts.zoom ?? 16,
    getBounds: () => ({
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    }),
    querySourceFeatures,
  };

  return { map, querySourceFeatures };
}

describe("createTilePrismProvider", () => {
  const inView = bboxAroundPoint(LNG, LAT, 300);

  it("returns prisms for a bbox inside the current view", () => {
    const { map } = fakeMap();
    const set = createTilePrismProvider(() => map).prismsFor(inView);

    expect(set?.prisms).toHaveLength(1);
    expect(set?.maxHeightM).toBe(18);
  });

  it("queries the building layer of the MapTiler source", () => {
    const { map, querySourceFeatures } = fakeMap();
    createTilePrismProvider(() => map).prismsFor(inView);

    expect(querySourceFeatures).toHaveBeenCalledWith("maptiler_planet", {
      sourceLayer: "building",
    });
  });

  it("declines a bbox outside the current view rather than reporting no buildings", () => {
    const { map } = fakeMap({ bounds: bboxAroundPoint(LNG, LAT, 100) });

    // An empty PrismSet here would read as "open sky" at high confidence. The whole
    // point of the null is that off-screen means "I don't know".
    expect(createTilePrismProvider(() => map).prismsFor(bboxAroundPoint(LNG, LAT, 5000))).toBeNull();
  });

  it("declines below the zoom where MapTiler serves building geometry", () => {
    const { map, querySourceFeatures } = fakeMap({ zoom: 11 });

    expect(createTilePrismProvider(() => map).prismsFor(inView)).toBeNull();
    expect(querySourceFeatures).not.toHaveBeenCalled();
  });

  it("reports full completeness only where the tile layer is complete", () => {
    // Between MIN_BUILDING_ZOOM and here the source still answers, but with a
    // decimated building layer — the case that reads as a confident sunlit street.
    expect(createTilePrismProvider(() => fakeMap({ zoom: 16 }).map).completeness?.()).toBe(1);
    expect(createTilePrismProvider(() => fakeMap({ zoom: 15 }).map).completeness?.()).toBe(1);
    expect(
      createTilePrismProvider(() => fakeMap({ zoom: 13 }).map).completeness?.(),
    ).toBeLessThan(1);
    expect(createTilePrismProvider(() => null).completeness?.()).toBe(0);
  });

  it("is not trusted for routing while its building layer is decimated", () => {
    // The whole point of the multiplier: a zoomed-out tile answer has to land under
    // LOW_CONFIDENCE so the caller consults the pixel sampler instead of routing on
    // geometry it only half received.
    const zoomedOut = createTilePrismProvider(() => fakeMap({ zoom: 13 }).map);
    const highSun = Math.PI / 4;

    expect(
      confidenceFor("tiles", highSun, 100, zoomedOut.completeness?.()),
    ).toBeLessThan(LOW_CONFIDENCE);
    expect(confidenceFor("tiles", highSun, 100, 1)).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });

  it("declines when there is no map yet", () => {
    expect(createTilePrismProvider(() => null).prismsFor(inView)).toBeNull();
  });

  it("queries once per view, not once per edge", () => {
    const { map, querySourceFeatures } = fakeMap();
    const provider = createTilePrismProvider(() => map);

    provider.prismsFor(inView);
    provider.prismsFor(bboxAroundPoint(LNG, LAT, 200));
    provider.prismsFor(bboxAroundPoint(LNG + 0.001, LAT, 150));

    expect(querySourceFeatures).toHaveBeenCalledTimes(1);
  });

  it("re-queries once the map has moved", () => {
    let bounds = bboxAroundPoint(LNG, LAT, 2000);
    const querySourceFeatures = vi.fn(() => [tileFeature(18)]);
    const map: TileMapLike = {
      getZoom: () => 16,
      getBounds: () => ({
        getWest: () => bounds.west,
        getSouth: () => bounds.south,
        getEast: () => bounds.east,
        getNorth: () => bounds.north,
      }),
      querySourceFeatures,
    };
    const provider = createTilePrismProvider(() => map);

    provider.prismsFor(inView);
    bounds = bboxAroundPoint(LNG + 0.05, LAT, 2000);
    provider.prismsFor(bboxAroundPoint(LNG + 0.05, LAT, 300));

    expect(querySourceFeatures).toHaveBeenCalledTimes(2);
  });
});

describe("createOverpassPrismProvider", () => {
  const bbox = bboxAroundPoint(LNG, LAT, 200);

  function footprints(heightM = 12): BuildingFootprint[] {
    return [{ id: 1, heightM, rings: [square(LNG, LAT, 0.0002)] }];
  }

  it("answers nothing before anything is loaded", () => {
    expect(createOverpassPrismProvider({ fetchFootprints: vi.fn() }).prismsFor(bbox)).toBeNull();
  });

  it("answers from cache after load", async () => {
    const fetchFootprints = vi.fn(async () => footprints());
    const provider = createOverpassPrismProvider({ fetchFootprints });

    await provider.load?.(bbox);

    expect(provider.prismsFor(bbox)?.prisms).toHaveLength(1);
    expect(fetchFootprints).toHaveBeenCalledTimes(1);
  });

  it("fetches a radius wider than the bbox, since shadows come from outside it", async () => {
    const fetchFootprints = vi.fn(async (_lng: number, _lat: number, _radiusM: number) =>
      footprints()
    );
    await createOverpassPrismProvider({ fetchFootprints }).load?.(bbox);

    const [, , radiusM] = fetchFootprints.mock.calls[0];
    expect(radiusM).toBeGreaterThan(bboxRadiusM(bbox));
  });

  it("does not refetch an area it already covers", async () => {
    const fetchFootprints = vi.fn(async () => footprints());
    const provider = createOverpassPrismProvider({ fetchFootprints });

    await provider.load?.(bbox);
    await provider.load?.(bboxAroundPoint(LNG, LAT, 50));

    expect(fetchFootprints).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent loads of the same area into one request", async () => {
    const fetchFootprints = vi.fn(async () => footprints());
    const provider = createOverpassPrismProvider({ fetchFootprints });

    await Promise.all([provider.load?.(bbox), provider.load?.(bbox), provider.load?.(bbox)]);

    expect(fetchFootprints).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared request alive when only one waiter aborts", async () => {
    let finish = () => {};
    let upstreamSignal: AbortSignal | undefined;
    const fetchFootprints = vi.fn(
      async (_lng: number, _lat: number, _radiusM: number, signal?: AbortSignal) =>
        new Promise<BuildingFootprint[]>((resolve, reject) => {
          upstreamSignal = signal;
          finish = () => resolve(footprints());
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const provider = createOverpassPrismProvider({ fetchFootprints });
    const first = new AbortController();
    const second = new AbortController();

    const firstLoad = provider.load?.(bbox, first.signal);
    const secondLoad = provider.load?.(bbox, second.signal);
    first.abort();

    await expect(firstLoad).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);
    finish();
    await expect(secondLoad).resolves.toBeUndefined();
    expect(provider.prismsFor(bbox)).not.toBeNull();
  });

  it("cancels upstream when the final waiter aborts and retries cleanly", async () => {
    const signals: AbortSignal[] = [];
    const fetchFootprints = vi
      .fn()
      .mockImplementationOnce(
        async (_lng: number, _lat: number, _radiusM: number, signal?: AbortSignal) =>
          new Promise<BuildingFootprint[]>((_resolve, reject) => {
            if (signal) signals.push(signal);
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      )
      .mockResolvedValueOnce(footprints(20));
    const provider = createOverpassPrismProvider({ fetchFootprints });
    const controller = new AbortController();

    const abandoned = provider.load?.(bbox, controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[0].aborted).toBe(true);

    await expect(provider.load?.(bbox)).resolves.toBeUndefined();
    expect(fetchFootprints).toHaveBeenCalledTimes(2);
    expect(provider.prismsFor(bbox)?.prisms[0].heightM).toBe(20);
  });

  it("declines an area too large for one Overpass call instead of issuing a doomed request", async () => {
    const fetchFootprints = vi.fn(async () => footprints());
    const provider = createOverpassPrismProvider({ fetchFootprints, maxFetchRadiusM: 500 });

    await provider.load?.(bboxAroundPoint(LNG, LAT, 5000));

    expect(fetchFootprints).not.toHaveBeenCalled();
    expect(provider.prismsFor(bboxAroundPoint(LNG, LAT, 5000))).toBeNull();
  });

  it("caches nothing when the fetch fails, so the field keeps saying it does not know", async () => {
    const fetchFootprints = vi.fn(async () => {
      throw new Error("Overpass building API error: 429 Too Many Requests");
    });
    const provider = createOverpassPrismProvider({ fetchFootprints });

    await expect(provider.load?.(bbox)).resolves.toBeUndefined();
    // Caching the failure as an empty set would turn a rate limit into a confident
    // claim of open sky.
    expect(provider.prismsFor(bbox)).toBeNull();
  });

  it("evicts old areas but keeps the one most recently used", async () => {
    const fetchFootprints = vi.fn(async () => footprints());
    const provider = createOverpassPrismProvider({ fetchFootprints });

    const areas = [0, 1, 2, 3, 4].map((i) => bboxAroundPoint(LNG + i * 0.5, LAT, 200));
    for (const area of areas.slice(0, 4)) await provider.load?.(area);

    provider.prismsFor(areas[0]); // touch the oldest so it survives
    await provider.load?.(areas[4]);

    expect(provider.prismsFor(areas[0])).not.toBeNull();
    expect(provider.prismsFor(areas[4])).not.toBeNull();
    expect(provider.prismsFor(areas[1])).toBeNull(); // the untouched oldest is gone
  });
});

describe("createOverpassCanopyProvider", () => {
  const bbox = bboxAroundPoint(LNG, LAT, 200);
  const JULY = new Date("2026-07-15T12:00:00Z");
  const JANUARY = new Date("2026-01-15T12:00:00Z");

  function trees(): CanopyFeature[] {
    return [{ id: 1, kind: "tree", points: [[LNG, LAT]], tags: { leaf_type: "broadleaved" } }];
  }

  it("answers nothing before anything is loaded", () => {
    expect(createOverpassCanopyProvider({ fetchCanopy: vi.fn() }).prismsFor(bbox, JULY)).toBeNull();
  });

  it("answers from cache after load", async () => {
    const fetchCanopy = vi.fn(async () => trees());
    const provider = createOverpassCanopyProvider({ fetchCanopy });

    await provider.load?.(bbox);

    expect(provider.prismsFor(bbox, JULY)?.prisms).toHaveLength(1);
    expect(fetchCanopy).toHaveBeenCalledTimes(1);
  });

  it("hands back the identical array for the same area and month", async () => {
    // Load-bearing, not an optimisation: `ShadowField` keys its prepared casters on
    // this array's identity, so a fresh array per query would miss that cache on every
    // single sample and re-flatten every crown in the neighbourhood.
    const provider = createOverpassCanopyProvider({ fetchCanopy: async () => trees() });
    await provider.load?.(bbox);

    const first = provider.prismsFor(bbox, JULY);
    const sameHour = provider.prismsFor(bbox, JULY);
    const laterThatDay = provider.prismsFor(bbox, new Date("2026-07-15T18:00:00Z"));
    const laterThatMonth = provider.prismsFor(bbox, new Date("2026-07-28T09:00:00Z"));

    expect(sameHour).toBe(first);
    expect(laterThatDay).toBe(first);
    expect(laterThatMonth).toBe(first);
  });

  it("rebuilds the crowns when the season changes, without refetching", async () => {
    const fetchCanopy = vi.fn(async () => trees());
    const provider = createOverpassCanopyProvider({ fetchCanopy });
    await provider.load?.(bbox);

    const summer = provider.prismsFor(bbox, JULY);
    const winter = provider.prismsFor(bbox, JANUARY);

    expect(winter).not.toBe(summer);
    expect(winter?.prisms[0].opacity).toBeLessThan(summer?.prisms[0].opacity ?? 1);
    // Geometry is not seasonal; only the opacity is. One fetch covers both.
    expect(fetchCanopy).toHaveBeenCalledTimes(1);
  });

  it("fetches a radius wider than the bbox, since crowns outside it still cast in", async () => {
    const fetchCanopy = vi.fn(async (_lng: number, _lat: number, _radiusM: number) => trees());
    await createOverpassCanopyProvider({ fetchCanopy }).load?.(bbox);

    const [, , radiusM] = fetchCanopy.mock.calls[0];
    expect(radiusM).toBeGreaterThan(bboxRadiusM(bbox));
  });

  it("collapses concurrent loads of the same area into one request", async () => {
    const fetchCanopy = vi.fn(async () => trees());
    const provider = createOverpassCanopyProvider({ fetchCanopy });

    await Promise.all([provider.load?.(bbox), provider.load?.(bbox), provider.load?.(bbox)]);

    expect(fetchCanopy).toHaveBeenCalledTimes(1);
  });

  it("does not cancel shared canopy work when one waiter aborts", async () => {
    let finish = () => {};
    let upstreamSignal: AbortSignal | undefined;
    const fetchCanopy = vi.fn(
      async (_lng: number, _lat: number, _radiusM: number, signal?: AbortSignal) =>
        new Promise<CanopyFeature[]>((resolve, reject) => {
          upstreamSignal = signal;
          finish = () => resolve(trees());
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const provider = createOverpassCanopyProvider({ fetchCanopy });
    const first = new AbortController();
    const second = new AbortController();

    const firstLoad = provider.load?.(bbox, first.signal);
    const secondLoad = provider.load?.(bbox, second.signal);
    first.abort();

    await expect(firstLoad).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);
    finish();
    await expect(secondLoad).resolves.toBeUndefined();
    expect(provider.prismsFor(bbox, JULY)).not.toBeNull();
  });

  it("cancels the final canopy waiter and permits a retry", async () => {
    let firstSignal: AbortSignal | undefined;
    const fetchCanopy = vi
      .fn()
      .mockImplementationOnce(
        async (_lng: number, _lat: number, _radiusM: number, signal?: AbortSignal) =>
          new Promise<CanopyFeature[]>((_resolve, reject) => {
            firstSignal = signal;
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      )
      .mockResolvedValueOnce(trees());
    const provider = createOverpassCanopyProvider({ fetchCanopy });
    const controller = new AbortController();

    const abandoned = provider.load?.(bbox, controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(firstSignal?.aborted).toBe(true);

    await provider.load?.(bbox);
    expect(fetchCanopy).toHaveBeenCalledTimes(2);
    expect(provider.prismsFor(bbox, JULY)).not.toBeNull();
  });

  it("declines an area too large for one Overpass call", async () => {
    const fetchCanopy = vi.fn(async () => trees());
    const provider = createOverpassCanopyProvider({ fetchCanopy, maxFetchRadiusM: 500 });

    await provider.load?.(bboxAroundPoint(LNG, LAT, 5000));

    expect(fetchCanopy).not.toHaveBeenCalled();
  });

  it("caches nothing when the fetch fails, rather than claiming a bare street", async () => {
    const provider = createOverpassCanopyProvider({
      fetchCanopy: async () => {
        throw new Error("Overpass canopy API error: 429 Too Many Requests");
      },
    });

    await expect(provider.load?.(bbox)).resolves.toBeUndefined();
    expect(provider.prismsFor(bbox, JULY)).toBeNull();
  });

  it("reports an area it fetched and found bare, which is not the same as declining", async () => {
    const provider = createOverpassCanopyProvider({ fetchCanopy: async () => [] });
    await provider.load?.(bbox);

    const set = provider.prismsFor(bbox, JULY);
    expect(set).not.toBeNull();
    expect(set?.prisms).toHaveLength(0);
  });
});

describe("createRasterCanopyProvider", () => {
  const bbox = bboxAroundPoint(LNG, LAT, 200);

  /**
   * A store that hands back one flat patch covering whatever it was asked for.
   *
   * The store's own behaviour — dedupe, cancellation, retry, stitching — is A8b's and
   * is tested against a fake COG in `canopyTileStore.test.ts`. What this provider owns
   * is the policy above it: never fetch from the synchronous path, never cache a
   * failure as "no canopy", and decline an area too large to succeed.
   */
  function fakeStore(read: (aoi: LonLatBbox) => Promise<CanopyPatch>): CanopyTileStore {
    return {
      read: (aoi) => read(aoi),
      stats: () => ({
        cachedBlocks: 0, cachedBytes: 0, blockHits: 0, blockMisses: 0,
        runsFetched: 0, retries: 0, evictions: 0,
      }),
      clear: () => {},
    };
  }

  function flatPatch(aoi: LonLatBbox, heightM = 12): CanopyPatch {
    return {
      heights: new Uint8Array(16 * 16).fill(heightM),
      valid: null,
      width: 16,
      height: 16,
      // A real patch covers whole pixels, so it contains the area asked for. Widened
      // a little here for the same reason, so `bboxContains` can succeed.
      bbox: [aoi[0] - 1e-4, aoi[1] - 1e-4, aoi[2] + 1e-4, aoi[3] + 1e-4],
      metresPerPixel: 2,
      overviewIndex: 2,
      quadkeys: ["0331110121"],
    };
  }

  it("answers nothing before anything is loaded", () => {
    const read = vi.fn();
    expect(createRasterCanopyProvider({ store: fakeStore(read) }).fieldFor(bbox)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("answers from cache after load", async () => {
    const read = vi.fn(async (aoi: LonLatBbox) => flatPatch(aoi));
    const provider = createRasterCanopyProvider({ store: fakeStore(read) });

    await provider.load?.(bbox);

    expect(provider.fieldFor(bbox)?.maxHeightM).toBe(12);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("fetches one area once, however many times it is asked for", async () => {
    const read = vi.fn(async (aoi: LonLatBbox) => flatPatch(aoi));
    const provider = createRasterCanopyProvider({ store: fakeStore(read) });

    await Promise.all([provider.load?.(bbox), provider.load?.(bbox)]);
    await provider.load?.(bbox);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps every sun cell a route loads, not just the last two", async () => {
    // `readyEdges` loads one area per 2 km sun cell, all at once. A cache smaller than
    // a route evicted the first cells before sampling read them, and those streets
    // silently lost their canopy (#300).
    const read = vi.fn(async (aoi: LonLatBbox) => flatPatch(aoi));
    const provider = createRasterCanopyProvider({ store: fakeStore(read) });
    const cells = Array.from({ length: 8 }, (_, i) => bboxAroundPoint(LNG + i * 0.02, LAT, 200));

    await Promise.all(cells.map((cell) => provider.load?.(cell)));

    for (const cell of cells) expect(provider.fieldFor(cell)).not.toBeNull();
  });

  it("declines an area too large for the store's pixel guard, without asking", async () => {
    // `CanopyTileStore.read` throws rather than degrading, and a provider that fires a
    // doomed read is worse than one that says it cannot speak for the area.
    const read = vi.fn(async (aoi: LonLatBbox) => flatPatch(aoi));
    const provider = createRasterCanopyProvider({ store: fakeStore(read) });
    const continent = bboxAroundPoint(LNG, LAT, 50_000);

    await provider.load?.(continent);

    expect(read).not.toHaveBeenCalled();
    expect(provider.fieldFor(continent)).toBeNull();
  });

  it("never caches a failed read as an area with no canopy", async () => {
    const read = vi.fn(async () => {
      throw new Error("source.coop said 504");
    });
    const provider = createRasterCanopyProvider({ store: fakeStore(read) });

    await expect(provider.load?.(bbox)).resolves.toBeUndefined();

    expect(provider.fieldFor(bbox)).toBeNull();
    // And it is free to try again, rather than having cached the failure.
    await provider.load?.(bbox);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops waiting on a slow read without abandoning it", async () => {
    // `ready()` is awaited on the route-calculation path. A cold read from
    // source.coop was measured at 3.4-9.7 s, and a route must not be made to wait
    // that long — but throwing the read away would mean it never lands at all.
    let land = () => {};
    const slow = vi.fn(
      (aoi: LonLatBbox) =>
        new Promise<CanopyPatch>((resolve) => {
          land = () => resolve(flatPatch(aoi));
        }),
    );
    const provider = createRasterCanopyProvider({
      store: fakeStore(slow),
      readyBudgetMs: 5,
    });

    await provider.load?.(bbox);

    expect(slow).toHaveBeenCalledTimes(1);
    expect(provider.fieldFor(bbox)).toBeNull();

    land();
    await Promise.resolve();
    await Promise.resolve();

    expect(provider.fieldFor(bbox)?.maxHeightM).toBe(12);
  });

  it("releases a timed-out raster waiter when its route is superseded", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const slow = vi.fn(
      async (_aoi: LonLatBbox, signal?: AbortSignal) =>
        new Promise<CanopyPatch>((_resolve, reject) => {
          upstreamSignal = signal;
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const store: CanopyTileStore = {
      read: (aoi, options) => slow(aoi, options?.signal),
      stats: () => ({
        cachedBlocks: 0, cachedBytes: 0, blockHits: 0, blockMisses: 0,
        runsFetched: 0, retries: 0, evictions: 0,
      }),
      clear: () => {},
    };
    const provider = createRasterCanopyProvider({ store, readyBudgetMs: 5 });
    const route = new AbortController();

    await provider.load?.(bbox, route.signal);
    expect(upstreamSignal?.aborted).toBe(false);

    route.abort();
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  });

  it("joins a read still in flight rather than starting a second", async () => {
    let land = () => {};
    const slow = vi.fn(
      (aoi: LonLatBbox) =>
        new Promise<CanopyPatch>((resolve) => {
          land = () => resolve(flatPatch(aoi));
        }),
    );
    const provider = createRasterCanopyProvider({
      store: fakeStore(slow),
      readyBudgetMs: 5,
    });

    await provider.load?.(bbox);
    await provider.load?.(bbox);

    expect(slow).toHaveBeenCalledTimes(1);
    land();
  });

  it("declines an area the patch does not fully cover", async () => {
    // The store clamps a window to the image, so a read near an unpublished tile can
    // come back covering less than was asked for. Half an answer is not an answer.
    const clipped = vi.fn(async (aoi: LonLatBbox) => {
      const patch = flatPatch(aoi);
      patch.bbox = [aoi[0], aoi[1], (aoi[0] + aoi[2]) / 2, aoi[3]];
      return patch;
    });
    const provider = createRasterCanopyProvider({ store: fakeStore(clipped) });

    await provider.load?.(bbox);

    expect(clipped).toHaveBeenCalledTimes(1);
    expect(provider.fieldFor(bbox)).toBeNull();
  });
});

describe("the two providers together", () => {
  it("uses tiles in view and Overpass outside it", async () => {
    const { map, querySourceFeatures } = fakeMap({ bounds: bboxAroundPoint(LNG, LAT, 500) });
    const fetchFootprints = vi.fn(async () => [
      { id: 1, heightM: 30, rings: [square(LNG + 1, LAT, 0.0002)] } as BuildingFootprint,
    ]);

    const field = createGeometryShadowField([
      createTilePrismProvider(() => map),
      createOverpassPrismProvider({ fetchFootprints }),
    ]);

    const inView = field.shadowAt(LNG, LAT, new Date("2026-06-21T12:00:00Z"));
    expect(inView.source).toBe("tiles");
    expect(querySourceFeatures).toHaveBeenCalled();

    const farAway: BBox = bboxAroundPoint(LNG + 1, LAT, 300);
    await field.ready(farAway);
    const outOfView = field.shadowAt(LNG + 1, LAT, new Date("2026-06-21T12:00:00Z"));

    expect(outOfView.source).toBe("overpass");
    expect(fetchFootprints).toHaveBeenCalled();
  });

  it("reports no source at all when neither provider can answer", () => {
    const field = createGeometryShadowField([
      createTilePrismProvider(() => null),
      createOverpassPrismProvider({ fetchFootprints: vi.fn() }),
    ]);

    const sample = field.shadowAt(LNG, LAT, new Date("2026-06-21T12:00:00Z"));

    expect(sample).toEqual({ shadow: 0, source: "none", confidence: 0 });
  });
});

describe("createShedProvider", () => {
  const MIDTOWN = { west: -73.99, south: 40.75, east: -73.98, north: 40.76 };
  const edge = { from: [-73.986, 40.755] as [number, number], to: [-73.984, 40.755] as [number, number] };
  const permitResult = (complete = true): ShedPermitResult => ({
    // ~1 m north of the edge — the left sidewalk.
    permits: [{ jobFilingNumber: "A", lng: -73.985, lat: 40.75501, expiresAt: "2026-12-01T00:00:00.000" }],
    coverage: MIDTOWN,
    complete,
  });

  it("declines until both permits are loaded and edges are bound", async () => {
    const provider = createShedProvider({ fetchPermits: async () => permitResult() });
    expect(provider.prismsFor(MIDTOWN)).toBeNull();
    await provider.load?.(MIDTOWN);
    expect(provider.prismsFor(MIDTOWN)).toBeNull();
    provider.bindEdges([edge]);
    expect(provider.prismsFor(MIDTOWN)?.prisms).toHaveLength(1);
  });

  it("hands back the same array until the edges are rebound", async () => {
    const provider = createShedProvider({ fetchPermits: async () => permitResult() });
    await provider.load?.(MIDTOWN);
    provider.bindEdges([edge]);
    const first = provider.prismsFor(MIDTOWN);
    expect(provider.prismsFor(MIDTOWN)).toBe(first);
    provider.bindEdges([edge]);
    expect(provider.prismsFor(MIDTOWN)).not.toBe(first);
  });

  it("reports an empty set, not a decline, when NYC has no sheds there", async () => {
    const provider = createShedProvider({
      fetchPermits: async () => ({ permits: [], coverage: MIDTOWN, complete: true }),
    });
    await provider.load?.(MIDTOWN);
    provider.bindEdges([edge]);
    expect(provider.prismsFor(MIDTOWN)?.prisms).toEqual([]);
  });

  it("caches nothing when the fetch fails or may be truncated", async () => {
    const failing = createShedProvider({ fetchPermits: async () => { throw new Error("503"); } });
    await failing.load?.(MIDTOWN);
    failing.bindEdges([edge]);
    expect(failing.prismsFor(MIDTOWN)).toBeNull();

    const truncated = createShedProvider({ fetchPermits: async () => permitResult(false) });
    await truncated.load?.(MIDTOWN);
    truncated.bindEdges([edge]);
    expect(truncated.prismsFor(MIDTOWN)).toBeNull();
  });

  it("lists the drawn sheds for the bound edges only, and nothing before a calculation", async () => {
    const provider = createShedProvider({ fetchPermits: async () => permitResult() });
    await provider.load?.(MIDTOWN);
    expect(provider.drawnRings()).toEqual([]);
    provider.bindEdges([edge]);
    expect(provider.drawnRings()).toEqual([]); // not sampled yet
    provider.prismsFor(MIDTOWN);
    expect(provider.drawnRings()).toHaveLength(1);
    // A later calculation over a graph with no street near the permit.
    provider.bindEdges([{ from: [-73.95, 40.78], to: [-73.949, 40.78] }]);
    provider.prismsFor(MIDTOWN);
    expect(provider.drawnRings()).toEqual([]);
  });

  it("draws a shed once even when two cached areas both hold its permit", async () => {
    // Two cached areas that overlap around the permit, neither containing the other.
    const WEST = { west: -73.99, south: 40.75, east: -73.98, north: 40.76 };
    const EAST = { west: -73.986, south: 40.75, east: -73.976, north: 40.76 };
    const provider = createShedProvider({
      fetchPermits: async (bbox) => ({ ...permitResult(), coverage: bbox }),
    });
    await provider.load?.(WEST);
    await provider.load?.(EAST);
    provider.bindEdges([edge]);
    expect(provider.prismsFor(WEST)?.prisms).toHaveLength(1);
    expect(provider.prismsFor(EAST)?.prisms).toHaveLength(1);
    expect(provider.drawnRings()).toHaveLength(1);
  });

  it("never fetches outside NYC", async () => {
    const fetchPermits = vi.fn(async () => permitResult());
    const provider = createShedProvider({ fetchPermits });
    await provider.load?.(bboxAroundPoint(LNG, LAT, 500));
    expect(fetchPermits).not.toHaveBeenCalled();
  });

  it("stops waiting on abort but lets the fetch fill the cache", async () => {
    let finish = (_: ShedPermitResult) => {};
    const provider = createShedProvider({
      fetchPermits: () => new Promise<ShedPermitResult>((resolve) => { finish = resolve; }),
    });
    const controller = new AbortController();
    const waiting = provider.load?.(MIDTOWN, controller.signal);
    controller.abort();
    await waiting;
    provider.bindEdges([edge]);
    expect(provider.prismsFor(MIDTOWN)).toBeNull();

    finish(permitResult());
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.prismsFor(MIDTOWN)?.prisms).toHaveLength(1);
  });
});
