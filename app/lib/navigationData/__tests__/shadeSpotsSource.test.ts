import { beforeEach, describe, expect, it, vi } from "vitest";
import * as remote from "../remoteNavigation";
import { findShadeSpots } from "../shadeSpotsSource";
import { isShadeWindowPayload } from "../../agent/shadeWindows";
import {
  shadeCell,
  SHADE_QUERY,
  SHADE_GENERATION,
  SHADE_BOUNDS,
} from "../../agent/__tests__/shadeFixture";
import type { NavigationSnapshot, NavigationShardSelection } from "../remoteNavigation";
import type { NavigationShadeShardRef, NavigationStreetShardRef } from "../shardContract";

vi.mock("../remoteNavigation", () => ({
  acquireNavigationSnapshot: vi.fn(),
  loadNavigationStreetShards: vi.fn(),
  loadNavigationShadeShard: vi.fn(),
  loadShadeSlotBlocks: vi.fn(),
  selectNavigationShardsForBoxes: vi.fn(),
  zoneAround: (lng: number, lat: number, radius: number) => ({
    south: lat - radius / 111000,
    north: lat + radius / 111000,
    west: lng - radius / 84000,
    east: lng + radius / 84000,
  }),
}));
const a = shadeCell();
const snapshot = {
  generation: SHADE_GENERATION,
  base: "https://data.test",
  manifest: {
    supportBounds: SHADE_BOUNDS,
    shadeShards: [{ key: "shades/cell-a.json" }],
    streetShards: [{ key: "streets/cell-a.json" }],
  },
} as unknown as NavigationSnapshot;
const refs = {
  streets: snapshot.manifest.streetShards,
  buildings: [],
  shadeShards: snapshot.manifest.shadeShards!,
} as NavigationShardSelection;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.mocked(remote.acquireNavigationSnapshot).mockResolvedValue(snapshot);
  vi.mocked(remote.selectNavigationShardsForBoxes).mockReturnValue(refs);
  vi.mocked(remote.loadNavigationStreetShards).mockResolvedValue([a.street]);
  vi.mocked(remote.loadNavigationShadeShard).mockResolvedValue(a.shade.shard);
  vi.mocked(remote.loadShadeSlotBlocks).mockImplementation(
    async (_snapshot, _shard, slots) =>
      new Map(slots.map((slot) => [slot, a.shade.blocks.get(slot)!])),
  );
});

describe("shade-window data adapter", () => {
  it("pins one generation and fetches only the snapped window slots", async () => {
    const result = await findShadeSpots({ ...SHADE_QUERY, fromMinutes: 847, toMinutes: 963 });
    expect(remote.acquireNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(remote.loadNavigationStreetShards).toHaveBeenCalledWith(
      snapshot,
      refs.streets,
      expect.anything(),
    );
    expect(remote.loadNavigationShadeShard).toHaveBeenCalledWith(
      snapshot,
      refs.shadeShards[0],
      expect.anything(),
    );
    expect(remote.loadShadeSlotBlocks).toHaveBeenCalledWith(
      snapshot,
      a.shade.shard,
      [420, 421, 422, 423, 424, 425, 426, 427],
      expect.anything(),
    );
    expect(result.status).toBe("ok");
    expect(isShadeWindowPayload(result)).toBe(true);
    expect(result.status === "ok" && result.reasons).toContain("snapped");
  });

  it("loads the full shade owner even when the initial street selection misses it", async () => {
    vi.mocked(remote.selectNavigationShardsForBoxes).mockReturnValue({ ...refs, streets: [] });
    expect((await findShadeSpots(SHADE_QUERY)).status).toBe("ok");
    expect(remote.loadNavigationStreetShards).toHaveBeenCalledWith(
      snapshot,
      refs.streets,
      expect.anything(),
    );
  });

  it("reports boundary coverage without rejecting a valid anchor", async () => {
    vi.mocked(remote.acquireNavigationSnapshot).mockResolvedValue({
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        supportBounds: { ...SHADE_BOUNDS, west: SHADE_QUERY.lng - 0.001 },
      },
    });
    const result = await findShadeSpots(SHADE_QUERY);
    expect(result.status === "ok" && result.reasons).toContain("incomplete-data");
  });

  it("retains verified cells and excludes the entire failed cell", async () => {
    const b = shadeCell(30, "cell-b");
    const bShadeRef = { key: "shades/cell-b.json" } as NavigationShadeShardRef;
    const bStreetRef = { key: "streets/cell-b.json" } as NavigationStreetShardRef;
    const both = {
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        streetShards: [...refs.streets, bStreetRef],
        shadeShards: [...refs.shadeShards, bShadeRef],
      },
    };
    vi.mocked(remote.acquireNavigationSnapshot).mockResolvedValue(both);
    vi.mocked(remote.selectNavigationShardsForBoxes).mockReturnValue({
      ...refs,
      streets: both.manifest.streetShards,
      shadeShards: both.manifest.shadeShards,
    });
    vi.mocked(remote.loadNavigationStreetShards).mockImplementation(async (_s, selected) => [
      selected[0].key.includes("cell-b") ? b.street : a.street,
    ]);
    vi.mocked(remote.loadNavigationShadeShard).mockImplementation(async (_s, ref) =>
      ref.key.includes("cell-b") ? b.shade.shard : a.shade.shard,
    );
    vi.mocked(remote.loadShadeSlotBlocks).mockImplementation(async (_s, shard, slots) => {
      if (shard.payload.key.includes("cell-b")) throw new Error("missing bytes");
      return new Map(slots.map((slot) => [slot, a.shade.blocks.get(slot)!]));
    });
    const result = await findShadeSpots(SHADE_QUERY);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected partial success");
    expect(result.results).toHaveLength(2);
    expect(result.results.every((spot) => spot.segmentKey === "10,11")).toBe(true);
    expect(result.reasons).toContain("incomplete-data");
  });

  it.each([
    "not_configured",
    "outside_coverage",
    "no_shade_table",
    "quarantined_generation",
    "load_failed",
  ] as const)("returns %s without guessed values", async (reason) => {
    if (reason === "not_configured")
      vi.mocked(remote.acquireNavigationSnapshot).mockResolvedValue(null);
    if (reason === "outside_coverage")
      vi.mocked(remote.selectNavigationShardsForBoxes).mockReturnValue(null);
    if (reason === "no_shade_table")
      vi.mocked(remote.acquireNavigationSnapshot).mockResolvedValue({
        ...snapshot,
        manifest: { ...snapshot.manifest, shadeShards: undefined },
      });
    if (reason === "quarantined_generation")
      vi.mocked(remote.acquireNavigationSnapshot).mockResolvedValue({
        ...snapshot,
        generation: "nyc-2026-09-18-b94934cd765a",
      });
    if (reason === "load_failed")
      vi.mocked(remote.loadNavigationStreetShards).mockRejectedValue(new Error("bad digest"));
    expect(await findShadeSpots(SHADE_QUERY)).toEqual({
      status: "unavailable",
      reason,
      results: [],
    });
  });

  it.each([
    [{ date: "bad" }, "invalid_query"],
    [{ fromMinutes: 1, toMinutes: 2 }, "empty_window"],
    [{ date: "2026-01-01", fromMinutes: 1140, toMinutes: 1200 }, "night"],
    [{ lng: -74.05 }, "no_candidates"],
  ])("honestly handles %j", async (overrides, reason) => {
    expect(await findShadeSpots({ ...SHADE_QUERY, ...overrides })).toEqual({
      status: "unavailable",
      reason,
      results: [],
    });
  });

  it.each([true, false])(
    "reports an area with no shade cells (streets: %s)",
    async (hasStreets) => {
      vi.mocked(remote.selectNavigationShardsForBoxes).mockReturnValue({
        ...refs,
        streets: hasStreets ? refs.streets : [],
        shadeShards: [],
      });
      expect(await findShadeSpots(SHADE_QUERY)).toEqual({
        status: "unavailable",
        reason: hasStreets ? "no_shade_table" : "no_candidates",
        results: [],
      });
      expect(remote.loadNavigationStreetShards).not.toHaveBeenCalled();
    },
  );

  it("bounds loading with a 15-second waiter deadline", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.mocked(remote.loadShadeSlotBlocks).mockImplementation(
      (_s, _shard, _slots, options) =>
        new Promise((_resolve, reject) =>
          options!.signal!.addEventListener("abort", () => reject(new Error("deadline")), {
            once: true,
          }),
        ),
    );
    const pending = findShadeSpots(SHADE_QUERY);
    await vi.waitFor(() => expect(remote.loadShadeSlotBlocks).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "load_failed", results: [] });
    expect(timeout).toHaveBeenCalledWith(15000);
  });
});
