import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paretoRoutes, type RoutingGraph } from "../routing";
import { handleRoutingCommand, type RoutingWorkerCommand } from "../routingWorkerProtocol";
import { randomGraph } from "./paretoCases.fixture";

/** A stand-in Worker: records posts; the test answers through `reply`. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: Event) => void) | null = null;
  posts: Array<{ command: RoutingWorkerCommand; transfer: Transferable[] }> = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(command: RoutingWorkerCommand, transfer: Transferable[]) {
    this.posts.push({ command, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  /** Answer post `i` the way the real worker would. */
  reply(i: number) {
    this.onmessage?.({ data: handleRoutingCommand(this.posts[i].command) } as MessageEvent);
  }
}

const opts = { crossingPenaltyM: 15 };
let graphA: RoutingGraph;
let graphB: RoutingGraph;

/** Let the (single-slice, for these small graphs) pack finish and post. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function client() {
  vi.resetModules();
  return import("../routingWorkerClient");
}

beforeEach(() => {
  FakeWorker.instances = [];
  graphA = randomGraph(11, 6, 6, 0);
  graphB = randomGraph(12, 7, 5, 0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("routing worker client", () => {
  it("matches replies to requests by id and transfers the graph buffers", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchParetoRoutes } = await client();
    const onPacked = vi.fn();
    const a = searchParetoRoutes(graphA, 0, 35, opts, { onPacked });
    const b = searchParetoRoutes(graphB, 0, 34, opts);
    await flush();
    expect(FakeWorker.instances).toHaveLength(1);
    const w = FakeWorker.instances[0];
    expect(onPacked).toHaveBeenCalledTimes(1);
    expect(w.posts[0].command.requestId).not.toBe(w.posts[1].command.requestId);
    expect(w.posts[0].transfer.length).toBeGreaterThan(0);
    expect(w.posts[0].transfer).toContain(w.posts[0].command.graph.distanceM.buffer);
    w.reply(1);
    w.reply(0);
    await expect(a).resolves.toStrictEqual(paretoRoutes(graphA, 0, 35, opts));
    await expect(b).resolves.toStrictEqual(paretoRoutes(graphB, 0, 34, opts));
  });

  it("aborting terminates the worker, rejects, and the next request starts a fresh one", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchParetoRoutes } = await client();
    const controller = new AbortController();
    const a = searchParetoRoutes(graphA, 0, 35, opts, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances[0].terminated).toBe(true);

    const b = searchParetoRoutes(graphB, 0, 34, opts);
    await flush();
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].reply(0);
    await expect(b).resolves.toStrictEqual(paretoRoutes(graphB, 0, 34, opts));
  });

  it("rejects at once when the signal is already aborted", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchParetoRoutes } = await client();
    const controller = new AbortController();
    controller.abort();
    await expect(searchParetoRoutes(graphA, 0, 35, opts, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("falls back to the main-thread search when the worker errors", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchParetoRoutes } = await client();
    const a = searchParetoRoutes(graphA, 0, 35, opts);
    await flush();
    const w = FakeWorker.instances[0];
    w.onerror?.(new Event("error"));
    await expect(a).resolves.toStrictEqual(paretoRoutes(graphA, 0, 35, opts));
    expect(w.terminated).toBe(true);
    searchParetoRoutes(graphB, 0, 34, opts);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("packs a large graph in slices and stops at an abort between them", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchParetoRoutes } = await client();
    const big = randomGraph(13, 40, 40, 0); // > 4,096 edges: several pack steps
    // Every clock read is 100 ms later, so every step ends a slice.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
    const controller = new AbortController();
    const onPacked = vi.fn();
    const search = searchParetoRoutes(big, 0, 1599, opts, { signal: controller.signal, onPacked });
    await flush();
    controller.abort();
    await expect(search).rejects.toMatchObject({ name: "AbortError" });
    expect(onPacked).not.toHaveBeenCalled();
    expect(FakeWorker.instances[0].posts).toHaveLength(0);
  });

  it("a sliced pack still posts the whole graph", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchParetoRoutes } = await client();
    const big = randomGraph(13, 40, 40, 0);
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
    const search = searchParetoRoutes(big, 0, 1599, opts);
    await vi.waitFor(() => expect(FakeWorker.instances[0].posts).toHaveLength(1));
    FakeWorker.instances[0].reply(0);
    vi.mocked(performance.now).mockRestore();
    await expect(search).resolves.toStrictEqual(paretoRoutes(big, 0, 1599, opts));
  });

  it("falls back to the main-thread search on an error event", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { searchParetoRoutes } = await client();
    const a = searchParetoRoutes(graphA, 0, 35, opts);
    await flush();
    const w = FakeWorker.instances[0];
    w.onmessage?.({ data: { type: "error", requestId: w.posts[0].command.requestId, error: "boom" } } as MessageEvent);
    await expect(a).resolves.toStrictEqual(paretoRoutes(graphA, 0, 35, opts));
  });

  it("searches on the main thread when there is no Worker or construction throws", async () => {
    vi.stubGlobal("Worker", undefined);
    let { searchParetoRoutes } = await client();
    await expect(searchParetoRoutes(graphA, 0, 35, opts)).resolves.toStrictEqual(paretoRoutes(graphA, 0, 35, opts));

    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("no workers here");
        }
      },
    );
    ({ searchParetoRoutes } = await client());
    await expect(searchParetoRoutes(graphB, 0, 34, opts)).resolves.toStrictEqual(paretoRoutes(graphB, 0, 34, opts));
  });
});
