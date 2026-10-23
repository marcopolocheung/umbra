import { afterEach, describe, expect, it, vi } from "vitest";
import type { SunBudgetCommand } from "../sunBudgetWorkerProtocol";

/** A stand-in Worker: records posts; the test answers or fails it. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: Event) => void) | null = null;
  posts: SunBudgetCommand[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(command: SunBudgetCommand) {
    this.posts.push(command);
  }
  terminate() {
    this.terminated = true;
  }
}

async function client() {
  vi.resetModules();
  return import("../sunBudgetClient");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../navigationData/reachGraph");
  FakeWorker.instances = [];
});

describe("sun budget client", () => {
  it("with no Worker, builds and searches on this thread through the same handler", async () => {
    vi.stubGlobal("Worker", undefined);
    vi.doMock("../../navigationData/reachGraph", async (orig) => ({
      ...(await orig<object>()),
      buildReachGraph: async () => ({ status: "uncovered", reason: "no navigation dataset" }),
    }));
    const { buildSunReachGraph } = await client();
    await expect(buildSunReachGraph({ center: [-74, 40.7], timeBudgetSec: 1800, departure: new Date(0) })).resolves.toEqual({
      status: "uncovered",
      reason: "no navigation dataset",
    });
  });

  it("matches a worker's answer to its request", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { buildSunReachGraph } = await client();
    const built = buildSunReachGraph({ center: [-74, 40.7], timeBudgetSec: 1800, departure: new Date(0) });
    const w = FakeWorker.instances[0];
    expect(w.posts[0]).toMatchObject({ type: "build", center: [-74, 40.7], timeBudgetSec: 1800 });
    const answer = { status: "uncovered", reason: "outside the shade table" };
    w.onmessage?.({ data: { type: "built", requestId: w.posts[0].requestId, built: answer } } as MessageEvent);
    await expect(built).resolves.toEqual(answer);
  });

  it("rejects what was in flight when the worker fails, so the caller can rebuild", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchSunReachGraph } = await client();
    const searched = searchSunReachGraph(1, { sunBudgetSec: 60, timeBudgetSec: 200 });
    const w = FakeWorker.instances[0];
    w.onmessage?.({ data: { type: "searched", requestId: 999, result: {} } } as MessageEvent); // another request's answer
    w.onerror?.(new Event("error"));
    await expect(searched).rejects.toThrow(/worker failed/);
    expect(w.terminated).toBe(true);
  });

  it("a superseded request rejects as aborted, without killing the worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchSunReachGraph } = await client();
    const controller = new AbortController();
    const searched = searchSunReachGraph(1, { sunBudgetSec: 60, timeBudgetSec: 200 }, { signal: controller.signal });
    const w = FakeWorker.instances[0];
    controller.abort();
    w.onmessage?.({ data: { type: "searched", requestId: w.posts[0].requestId, result: {} } } as MessageEvent);
    await expect(searched).rejects.toMatchObject({ name: "AbortError" });
    expect(w.terminated).toBe(false);
  });
});
