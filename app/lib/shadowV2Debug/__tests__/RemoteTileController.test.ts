import { describe, expect, it } from "vitest";
import { RemoteTileController, MAX_CONCURRENT_TILE_LOADS, PEAK_TILE_BYTES } from "../RemoteTileController";
import type { DebugWorkerEvent } from "../protocol";
import { FIXTURE_GENERATION, FIXTURE_TILE, makeDebugV2Fixtures } from "./v2Fixtures";

function response(bytes: Uint8Array, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    arrayBuffer: async () => bytes.slice().buffer,
    clone() { return response(bytes, status); },
  };
}
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function configured(options: { bundle?: Uint8Array; schedule?: (task: () => void) => void; budget?: number; cache?: boolean } = {}) {
  const fixture = await makeDebugV2Fixtures();
  const events: DebugWorkerEvent[] = [];
  const payloads = new Map<string, Uint8Array>([
    [fixture.urls.current, fixture.pointer], [fixture.urls.root, fixture.root], [fixture.urls.coverage, fixture.coverage], [fixture.urls.tile, options.bundle ?? fixture.bundle],
  ]);
  let tileFetches = 0;
  const cache = new Map<string, ReturnType<typeof response>>();
  const controller = new RemoteTileController({
    schedule: options.schedule,
    emit: (event) => events.push(event),
    caches: options.cache ? { open: async () => ({
      match: async (url: string) => cache.get(url)?.clone(),
      put: async (url: string, value) => { cache.set(url, value.clone() as ReturnType<typeof response>); },
    }) } : undefined,
    fetch: async (url) => {
      if (url === fixture.urls.tile) tileFetches++;
      const body = payloads.get(url);
      return body ? response(body) : response(new Uint8Array(), 404);
    },
  });
  controller.handle({ type: "configureGeneration", requestId: 1, baseUrl: "https://shadow.fixture.test", budget: options.budget ?? 96 * 1024 * 1024 });
  await settle();
  expect(events.some((event) => event.type === "generationReady")).toBe(true);
  return { controller, events, fixture, tileFetches: () => tileFetches };
}

describe("RemoteTileController", () => {
  it("pins a valid v2 pointer/root/coverage and rejects corrupt bundles as errors, never empty tiles", async () => {
    const { controller, events } = await configured({ bundle: (await makeDebugV2Fixtures()).corruptBundle });
    controller.handle({ type: "setInterests", requestId: 2, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: [FIXTURE_TILE] });
    await settle();
    expect(events.some((event) => event.type === "tileError" && event.tile === FIXTURE_TILE)).toBe(true);
    expect(events.some((event) => event.type === "tileReady" && event.tile === FIXTURE_TILE)).toBe(false);
  });

  it("fails closed for mixed-generation and root-identity-mismatch bundles", async () => {
    const fixtures = await makeDebugV2Fixtures();
    for (const bundle of [fixtures.mixedGenerationBundle, fixtures.rootIdentityMismatchBundle]) {
      const { controller, events } = await configured({ bundle });
      controller.handle({ type: "setInterests", requestId: 2, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: [FIXTURE_TILE] });
      await settle();
      expect(events.some((event) => event.type === "tileError" && event.tile === FIXTURE_TILE)).toBe(true);
      expect(events.some((event) => event.type === "tileReady")).toBe(false);
    }
  });

  it("marks unknown source-support pixels incomplete instead of treating them as clear", async () => {
    const fixtures = await makeDebugV2Fixtures();
    const { controller, events } = await configured({ bundle: fixtures.unknownSupportBundle });
    controller.handle({ type: "setInterests", requestId: 2, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: [FIXTURE_TILE] });
    await settle();
    expect(events.some((event) => event.type === "tileReady" && !event.complete)).toBe(true);
    expect(events.some((event) => event.type === "tileIncomplete" && /unknown source support/.test(event.error ?? ""))).toBe(true);
  });

  it("suppresses a queued stale interest before it can fetch or stage", async () => {
    const queued: Array<() => void> = [];
    const { controller, events, tileFetches } = await configured({ schedule: (task) => queued.push(task) });
    controller.handle({ type: "setInterests", requestId: 2, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: [FIXTURE_TILE] });
    controller.handle({ type: "setInterests", requestId: 3, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: [] });
    queued.splice(0).forEach((task) => task());
    await settle();
    expect(tileFetches()).toBe(0);
    expect(events.some((event) => event.type === "tileReady")).toBe(false);
    expect(events.some((event) => event.type === "tileReleased" && event.tile === FIXTURE_TILE)).toBe(true);
  });

  it("keeps an in-flight tile leased when another interest still wants it", async () => {
    const { controller, events } = await configured();
    controller.handle({ type: "setInterests", requestId: 2, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: [FIXTURE_TILE] });
    controller.handle({ type: "setInterests", requestId: 3, generation: FIXTURE_GENERATION, interestId: "probe", tiles: [FIXTURE_TILE] });
    controller.handle({ type: "releaseInterest", requestId: 4, generation: FIXTURE_GENERATION, interestId: "viewport" });
    await settle();
    expect(events.some((event) => event.type === "tileReady" && event.tile === FIXTURE_TILE)).toBe(true);
    expect(events.some((event) => event.type === "tileReleased" && event.requestId === 4)).toBe(false);
  });

  it("accounts Cache Storage per generation and resets the visible namespace on supersession", async () => {
    const { controller, events } = await configured({ cache: true });
    controller.handle({ type: "setInterests", requestId: 2, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: [FIXTURE_TILE] });
    await settle();
    expect(events.filter((event) => event.type === "accounting").some((event) => event.type === "accounting" && event.accounting.cacheBytes > 0)).toBe(true);
    controller.handle({ type: "configureGeneration", requestId: 3, baseUrl: "https://shadow.fixture.test", budget: 96 * 1024 * 1024 });
    await settle();
    const accounting = events.filter((event) => event.type === "accounting").at(-1);
    expect(accounting?.type === "accounting" && accounting.accounting.cacheBytes).toBe(0);
  });

  it("reserves before fetch and refuses a load that cannot fit the 96 MiB-style budget", async () => {
    const { controller, events, tileFetches } = await configured({ budget: PEAK_TILE_BYTES - 1 });
    controller.handle({ type: "setInterests", requestId: 2, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: [FIXTURE_TILE] });
    await settle();
    expect(events.some((event) => event.type === "tileIncomplete" && /budget refusal/.test(event.error ?? ""))).toBe(true);
    expect(tileFetches()).toBe(0);
  });

  it("publishes a hard two-load bound including work that is only queued", async () => {
    const queued: Array<() => void> = [];
    const { controller, events } = await configured({ schedule: (task) => queued.push(task) });
    // Duplicates cannot bypass the bound; the accounting is observable before
    // microtasks start and is the same path used for a nine-tile viewport.
    controller.handle({ type: "setInterests", requestId: 2, generation: FIXTURE_GENERATION, interestId: "viewport", tiles: Array.from({ length: 9 }, () => FIXTURE_TILE) });
    const accounting = events.filter((event) => event.type === "accounting").at(-1);
    expect(queued.length).toBeLessThanOrEqual(MAX_CONCURRENT_TILE_LOADS);
    expect(accounting?.type === "accounting" && accounting.accounting.inFlight).toBeLessThanOrEqual(MAX_CONCURRENT_TILE_LOADS);
  });
});
