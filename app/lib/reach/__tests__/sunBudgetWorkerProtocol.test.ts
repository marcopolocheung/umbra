import { describe, expect, it } from "vitest";
import type { ReachGraph } from "../../navigationData/reachGraph";
import { sunReach } from "../../sunReach";
import { randomGraph } from "../../__tests__/paretoCases.fixture";
import {
  createSunBudgetHandler,
  eventTransferList,
  nodeMap,
  SUN_BUDGET_WORKER_PROTOCOL_VERSION,
  type SunBudgetCommand,
} from "../sunBudgetWorkerProtocol";

const P = SUN_BUDGET_WORKER_PROTOCOL_VERSION;
const timeAware = { bucketMs: 60_000, bucketCount: 4 };
/** A build that answers with a fixed seeded graph, as `buildReachGraph` would for a covered start. */
const fakeBuild = (seed: number) => async (): Promise<ReachGraph> => ({
  status: "ok",
  graph: randomGraph(seed, 6, 6, 4),
  startId: 0,
  startPoint: [-74, 40.7],
  timeAware,
  clipped: false,
});
const build = (requestId: number): SunBudgetCommand => ({
  type: "build", protocol: P, requestId, center: [-74, 40.7], timeBudgetSec: 1800, departureMs: 0,
});
const search = (requestId: number, graphId: number): SunBudgetCommand => ({
  type: "search", protocol: P, requestId, graphId, options: { sunBudgetSec: 60, timeBudgetSec: 200 },
});

describe("sun budget worker protocol", () => {
  it("searches the kept graph and answers exactly what sunReach does on the main thread", async () => {
    const handle = createSunBudgetHandler(fakeBuild(5));
    const built = await handle(build(1));
    expect(built.type).toBe("built");
    if (built.type !== "built" || built.built.status !== "ok") throw new Error("not built");
    const searched = await handle(search(2, built.built.graphId));
    const expected = sunReach(randomGraph(5, 6, 6, 4), 0, { sunBudgetSec: 60, timeBudgetSec: 200, timeAware });
    expect(searched).toEqual({ type: "searched", requestId: 2, result: { ...expected, stats: expect.anything() } });
    expect(expected.reachable.length).toBeGreaterThan(0);
  });

  it("hands over node positions the reach layer can draw every region edge with", async () => {
    const handle = createSunBudgetHandler(fakeBuild(5));
    const built = await handle(build(1));
    if (built.type !== "built" || built.built.status !== "ok") throw new Error("not built");
    const nodes = nodeMap(built.built);
    const graph = randomGraph(5, 6, 6, 4);
    for (const [id, node] of graph.nodes) expect(nodes.get(id)).toEqual({ lat: node.lat, lon: node.lon });
    // The arrays move, not copy.
    expect(eventTransferList(built)).toHaveLength(3);
  });

  it("refuses to search a graph it does not keep — never an older one", async () => {
    let seed = 5;
    const handle = createSunBudgetHandler(async () => fakeBuild(seed++)());
    const first = await handle(build(1));
    const second = await handle(build(2));
    if (first.type !== "built" || first.built.status !== "ok") throw new Error("not built");
    if (second.type !== "built" || second.built.status !== "ok") throw new Error("not built");
    expect(await handle(search(3, first.built.graphId))).toMatchObject({ type: "error", requestId: 3 });
    expect(await handle(search(4, second.built.graphId))).toMatchObject({ type: "searched" });
  });

  it("keeps the newer of two overlapping builds, whichever finishes last", async () => {
    // The first build is slow (a far start's shards); a second tap's build finishes first.
    let releaseFirst!: () => void;
    let n = 0;
    const handle = createSunBudgetHandler(async () => {
      const seed = n++ === 0 ? 5 : 6;
      if (seed === 5) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return fakeBuild(seed)();
    });
    const slow = handle(build(1));
    const fast = await handle(build(2));
    releaseFirst();
    expect(await slow).toMatchObject({ type: "error", requestId: 1 });
    if (fast.type !== "built" || fast.built.status !== "ok") throw new Error("not built");
    expect(await handle(search(3, fast.built.graphId))).toMatchObject({ type: "searched" });
  });

  it("passes an uncovered start through, and rejects a bad command", async () => {
    const handle = createSunBudgetHandler(async () => ({ status: "uncovered", reason: "outside the shade table" }));
    expect(await handle(build(1))).toEqual({ type: "built", requestId: 1, built: { status: "uncovered", reason: "outside the shade table" } });
    expect(await handle({ ...build(2), protocol: "v0" } as never)).toMatchObject({ type: "error", requestId: 2 });
  });
});
