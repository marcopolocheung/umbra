/**
 * Unit tests for app/lib/overpass.ts
 *
 * Uses vi.stubGlobal to mock fetch — no network access required.
 * Each test uses a unique bbox to avoid hitting the module-level LRU cache.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildRoutingGraphFromElements,
  fetchBuildingFootprintsAround,
  fetchCanopyAround,
  fetchRoutingGraph,
  fetchStationEntrances,
  fetchStationEntranceBoxes,
  boxAround,
} from "../overpass";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Helper: unique bbox counter so tests never share a cached result
let bboxIdx = 0;
function nextBbox(): [number, number, number, number] {
  bboxIdx++;
  // Place each bbox far from each other to guarantee no cache containment
  const base = bboxIdx * 5;
  return [base, base, base + 0.01, base + 0.01];
}

// ── XML error detection ───────────────────────────────────────────────────────

describe("fetchRoutingGraph — XML error detection", () => {
  it("throws a user-friendly Error (not a JSON SyntaxError) when Overpass returns XML", async () => {
    const xmlBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<osm><remark>Query timed out after 60 seconds</remark></osm>";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        // Current code calls res.json(); mock it throwing SyntaxError as real fetch would
        json: () =>
          Promise.reject(
            new SyntaxError(
              `Unexpected token '<', "<?xml vers"... is not valid JSON`
            )
          ),
        // After the fix, code will call res.text() instead
        text: async () => xmlBody,
      })
    );

    let caught: unknown;
    try {
      await fetchRoutingGraph(...nextBbox());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    // Must NOT surface the raw JSON parse message to the user
    expect((caught as Error).message).not.toMatch(/Unexpected token/i);
    expect((caught as Error).message).not.toMatch(/is not valid JSON/i);
    // Must be human-readable
    expect((caught as Error).message.length).toBeGreaterThan(20);
  });
});

describe("fetchRoutingGraph — transient proxy failures", () => {
  it.each([429, 502, 503, 504])(
    "shows the actionable busy-service message for HTTP %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status,
          statusText: "upstream detail",
        })
      );

      await expect(fetchRoutingGraph(...nextBbox())).rejects.toThrow(
        "The map server is busy — try a smaller area or wait a moment and retry."
      );
    }
  );
});

describe("fetchBuildingFootprintsAround", () => {
  it("fetches way building footprints with parsed heights through the Overpass proxy", async () => {
    const building = {
      type: "way",
      id: 5001,
      tags: { building: "yes", "building:levels": "4" },
      geometry: [
        { lat: 40.0, lon: -74.0 },
        { lat: 40.0, lon: -73.999 },
        { lat: 40.001, lon: -73.999 },
        { lat: 40.001, lon: -74.0 },
        { lat: 40.0, lon: -74.0 },
      ],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ elements: [building] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const [south, west] = nextBbox();
    const buildings = await fetchBuildingFootprintsAround(west, south, 120);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0][1]?.body);
    expect(decodeURIComponent(body)).toContain('way["building"]');
    expect(decodeURIComponent(body)).toContain('relation["building"]["type"="multipolygon"]');
    expect(buildings).toEqual([
      {
        id: 5001,
        heightM: 12,
        rings: [[
          [-74.0, 40.0],
          [-73.999, 40.0],
          [-73.999, 40.001],
          [-74.0, 40.001],
          [-74.0, 40.0],
        ]],
      },
    ]);
  });

  it("assembles multipolygon relation outer members into closed building rings", async () => {
    const relation = {
      type: "relation",
      id: 6001,
      tags: { building: "yes", height: "18" },
      members: [
        {
          type: "way",
          role: "outer",
          geometry: [
            { lat: 40.0, lon: -74.0 },
            { lat: 40.0, lon: -73.999 },
            { lat: 40.001, lon: -73.999 },
          ],
        },
        {
          type: "way",
          role: "outer",
          geometry: [
            { lat: 40.001, lon: -73.999 },
            { lat: 40.001, lon: -74.0 },
            { lat: 40.0, lon: -74.0 },
          ],
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ elements: [relation] }),
      })
    );

    const [south, west] = nextBbox();
    const buildings = await fetchBuildingFootprintsAround(west, south, 120);

    expect(buildings).toEqual([
      {
        id: 6001,
        heightM: 18,
        rings: [[
          [-74.0, 40.0],
          [-73.999, 40.0],
          [-73.999, 40.001],
          [-74.0, 40.001],
          [-74.0, 40.0],
        ]],
      },
    ]);
  });

  it("reuses cached building footprints for contained repeat probes without sharing mutations", async () => {
    const building = {
      type: "way",
      id: 7001,
      tags: { building: "yes", height: "9" },
      geometry: [
        { lat: 11.0, lon: 11.0 },
        { lat: 11.0, lon: 11.001 },
        { lat: 11.001, lon: 11.001 },
        { lat: 11.001, lon: 11.0 },
        { lat: 11.0, lon: 11.0 },
      ],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ elements: [building] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const [south, west] = nextBbox();
    const first = await fetchBuildingFootprintsAround(west, south, 240);
    first[0].rings[0][0][0] = -999;
    first[0].rings.push([[0, 0]]);

    const second = await fetchBuildingFootprintsAround(west, south, 60);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second[0].rings).toEqual([[
      [11.0, 11.0],
      [11.001, 11.0],
      [11.001, 11.001],
      [11.0, 11.001],
      [11.0, 11.0],
    ]]);
  });
});

// ── out body geom — inline geometry parsing ───────────────────────────────────

describe("fetchRoutingGraph — out body geom inline geometry", () => {
  it("builds the routing graph from way.geometry coordinates (no separate node elements)", async () => {
    // out body geom format: ways include a `geometry` array with {lat,lon} per node ref.
    // There are NO separate node elements in the response — coordinates come inline.
    const way = {
      type: "way",
      id: 1001,
      nodes: [10, 11],
      tags: { highway: "cycleway", surface: "gravel", bicycle: "designated", foot: "yes" },
      geometry: [
        { lat: 43.7701, lon: 11.2558 },
        { lat: 43.7702, lon: 11.2559 },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ elements: [way] }),
      })
    );

    const graph = await fetchRoutingGraph(...nextBbox());

    // Both node IDs must be present and have correct coordinates
    expect(graph.nodes.has(10)).toBe(true);
    expect(graph.nodes.has(11)).toBe(true);
    expect(graph.nodes.get(10)?.lat).toBeCloseTo(43.7701);
    expect(graph.nodes.get(10)?.lon).toBeCloseTo(11.2558);
    expect(graph.nodes.get(11)?.lat).toBeCloseTo(43.7702);
    expect(graph.nodes.get(11)?.lon).toBeCloseTo(11.2559);

    // The edge must exist in both directions
    const edgesFrom10 = graph.adj.get(10);
    expect(edgesFrom10).toBeDefined();
    const edgeTo11 = edgesFrom10!.find((e) => e.toId === 11);
    expect(edgeTo11).toBeDefined();
    expect(edgeTo11).toMatchObject({
      highway: "cycleway",
      surface: "gravel",
      bicycle: "designated",
      foot: "yes",
    });

    const edgeTo10 = graph.adj.get(11)!.find((e) => e.toId === 10);
    expect(edgeTo10).toMatchObject({
      highway: "cycleway",
      surface: "gravel",
      bicycle: "designated",
      foot: "yes",
    });
  });
});

// ── smoothness ingestion (E4) ────────────────────────────────────────────────

describe("buildRoutingGraphFromElements — smoothness", () => {
  it("carries smoothness=* onto edges; absent tags stay undefined", () => {
    const graph = buildRoutingGraphFromElements([
      {
        type: "way",
        id: 2001,
        nodes: [20, 21],
        tags: { highway: "pedestrian", surface: "sett", smoothness: "good" },
        geometry: [
          { lat: 40.4151, lon: -3.7023 },
          { lat: 40.4152, lon: -3.7023 },
        ],
      },
      {
        type: "way",
        id: 2002,
        nodes: [21, 22],
        tags: { highway: "footway" },
        geometry: [
          { lat: 40.4152, lon: -3.7023 },
          { lat: 40.4153, lon: -3.7023 },
        ],
      },
    ]);

    expect(graph.adj.get(20)!.find((e) => e.toId === 21)).toMatchObject({
      surface: "sett",
      smoothness: "good",
    });
    expect(graph.adj.get(21)!.find((e) => e.toId === 22)?.smoothness).toBeUndefined();
  });
});

// ── Graph cache isolation ────────────────────────────────────────────────────
describe("fetchRoutingGraph — cache isolation", () => {
  it("returns a fresh graph clone from cache so route mutations do not leak", async () => {
    const way = {
      type: "way",
      id: 1101,
      nodes: [110, 111],
      tags: { highway: "footway" },
      geometry: [
        { lat: 43.7701, lon: 11.2558 },
        { lat: 43.7702, lon: 11.2559 },
      ],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ elements: [way] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const [south, west, north, east] = nextBbox();
    const first = await fetchRoutingGraph(south, west, north, east);
    first.nodes.set(-1, { id: -1, lat: 0, lon: 0 });
    first.adj.get(110)![0].shadowFactor = 0.95;
    first.adj.set(-1, [{ toId: 110, distanceM: 1, shadowFactor: 1 }]);

    const second = await fetchRoutingGraph(
      south + 0.001,
      west + 0.001,
      north - 0.001,
      east - 0.001
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second.nodes.has(-1)).toBe(false);
    expect(second.adj.has(-1)).toBe(false);
    expect(second.adj.get(110)?.[0].shadowFactor).toBe(0);
  });
});

// ── closed pedestrian way filter ──────────────────────────────────────────────

describe("fetchRoutingGraph — closed pedestrian way filter", () => {
  it("excludes closed highway=pedestrian ways (plaza area polygons) from the routing graph", async () => {
    // Closed way: first node ID === last node ID → this is an area polygon (e.g., Piazza della Signoria).
    // These ways form ring polygons that are not walkable paths; their mass expansion via `>` was
    // causing Overpass timeouts. Client-side filter must discard them.
    const closedPedestrianWay = {
      type: "way",
      id: 2001,
      nodes: [20, 21, 22, 20], // closed ring
      tags: { highway: "pedestrian" },
      geometry: [
        { lat: 43.7700, lon: 11.2550 },
        { lat: 43.7701, lon: 11.2551 },
        { lat: 43.7702, lon: 11.2552 },
        { lat: 43.7700, lon: 11.2550 }, // same as first
      ],
    };

    // An open footway that SHOULD be included
    const openFootway = {
      type: "way",
      id: 2002,
      nodes: [30, 31],
      tags: { highway: "footway" },
      geometry: [
        { lat: 43.7710, lon: 11.2560 },
        { lat: 43.7711, lon: 11.2561 },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({ elements: [closedPedestrianWay, openFootway] }),
      })
    );

    const graph = await fetchRoutingGraph(...nextBbox());

    // Closed pedestrian ring must NOT appear in the graph
    expect(graph.nodes.has(20)).toBe(false);
    expect(graph.nodes.has(21)).toBe(false);
    expect(graph.nodes.has(22)).toBe(false);

    // Open footway MUST appear
    expect(graph.nodes.has(30)).toBe(true);
    expect(graph.nodes.has(31)).toBe(true);
  });
});

// ── area=yes filter ───────────────────────────────────────────────────────────

describe("fetchRoutingGraph — Overpass query shape", () => {
  it('excludes area=yes ways from the query sent to Overpass', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ elements: [] }),
      text: async () => JSON.stringify({ elements: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // Will throw "No walkable roads found" — that's fine, fetch was still called
    await fetchRoutingGraph(...nextBbox()).catch(() => {});

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const query = decodeURIComponent(
      (init.body as string).replace(/^data=/, "")
    );
    // The query must filter out area polygons
    expect(query).toContain('"area"!');
  });
});

// ── station entrances tagging ───────────────────────────────────────────────

describe("upstream failure reporting", () => {
  it("prints the proxy's per-attempt reason when the pool is exhausted", async () => {
    // Without this the browser shows "busy" and the reason lives only in server
    // logs, which expire. Rate limiting and a slow query look identical here and
    // are fixed differently.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        clone: () => ({
          json: async () => ({
            error: "Map data service temporarily unavailable",
            attempts: [
              { endpoint: "overpass-api.de", attempt: 1, durationMs: 8001, failureClass: "attempt_timeout" },
              { endpoint: "overpass.private.coffee", attempt: 2, durationMs: 120, status: 429, failureClass: "retryable_http" },
            ],
          }),
        }),
      }),
    );

    await expect(fetchRoutingGraph(...nextBbox())).rejects.toThrow(/map server is busy/i);

    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("attempt_timeout");
    expect(line).toContain("overpass-api.de");
    expect(line).toContain("429");
    warn.mockRestore();
  });

  it("still reports the user-facing error when the body says nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        clone: () => ({ json: async () => { throw new Error("not json"); } }),
      }),
    );

    await expect(fetchRoutingGraph(...nextBbox())).rejects.toThrow(/map server is busy/i);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("fetchStationEntranceBoxes — several boxes, one request", () => {
  function stubOnce(elements: unknown[]) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ elements }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
    const init = fetchMock.mock.calls[call][1] as { body: string };
    return decodeURIComponent(init.body);
  }

  it("asks for every box in a single Overpass request", async () => {
    // Two station boxes must not cost two round trips — the whole point of
    // this path is to reduce what the public API is asked for.
    const fetchMock = stubOnce([
      { type: "node", id: 21, lat: 40.75, lon: -73.98, tags: { railway: "subway_entrance" } },
    ]);
    const [s1, w1, n1, e1] = nextBbox();
    const [s2, w2, n2, e2] = nextBbox();

    await fetchStationEntranceBoxes([
      { south: s1, west: w1, north: n1, east: e1 },
      { south: s2, west: w2, north: n2, east: e2 },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchMock);
    expect(body).toContain(`(${s1},${w1},${n1},${e1})`);
    expect(body).toContain(`(${s2},${w2},${n2},${e2})`);
  });

  it("only asks for the boxes it has not already cached", async () => {
    const first = stubOnce([
      { type: "node", id: 31, lat: 1, lon: 2, tags: { railway: "subway_entrance" } },
    ]);
    const [s1, w1, n1, e1] = nextBbox();
    const boxA = { south: s1, west: w1, north: n1, east: e1 };
    await fetchStationEntranceBoxes([boxA]);
    expect(first).toHaveBeenCalledTimes(1);

    const second = stubOnce([
      { type: "node", id: 32, lat: 3, lon: 4, tags: { railway: "subway_entrance" } },
    ]);
    const [s2, w2, n2, e2] = nextBbox();
    const boxB = { south: s2, west: w2, north: n2, east: e2 };
    const { entrances: merged } = await fetchStationEntranceBoxes([boxA, boxB]);

    expect(second).toHaveBeenCalledTimes(1);
    const body = bodyOf(second);
    expect(body).toContain(`(${s2},${w2},${n2},${e2})`);
    expect(body).not.toContain(`(${s1},${w1},${n1},${e1})`);
    // The cached box's nodes still come back, alongside the newly fetched ones.
    expect(merged.map((n) => n.id).sort()).toEqual([31, 32]);
  });

  it("returns a node once when boxes overlap", async () => {
    const fetchMock = stubOnce([
      { type: "node", id: 41, lat: 5, lon: 6, tags: { railway: "subway_entrance" } },
    ]);
    const [s, w, n, e] = nextBbox();
    const box = { south: s, west: w, north: n, east: e };
    // The same box twice is the degenerate overlap: one request, one node.
    const { entrances: res } = await fetchStationEntranceBoxes([box, box]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.map((x) => x.id)).toEqual([41]);
  });

  it("makes no request at all for an empty box list", async () => {
    const fetchMock = stubOnce([]);
    expect(await fetchStationEntranceBoxes([])).toEqual({ entrances: [], failed: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("boxAround", () => {
  it("keeps the box square in metres, not in degrees", () => {
    // At NYC's latitude a degree of longitude is ~76% of a degree of latitude,
    // so an equal-degree box would be narrower on the ground than intended.
    const box = boxAround(40.75, -73.98, 400);
    const latSpanDeg = box.north - box.south;
    const lonSpanDeg = box.east - box.west;
    expect(lonSpanDeg).toBeGreaterThan(latSpanDeg);
    expect((latSpanDeg / 2) * 111_320).toBeCloseTo(400, 0);
  });

  it("does not blow up approaching the poles", () => {
    const box = boxAround(89.9, 0, 400);
    expect(Number.isFinite(box.east)).toBe(true);
    expect(box.east - box.west).toBeLessThan(1);
  });
});

describe("fetchStationEntrances — kind tagging", () => {
  it("tags railway=subway_entrance nodes as kind=entrance and station nodes as kind=station", async () => {
    const elements = [
      { type: "node", id: 1, lat: 1, lon: 2, tags: { railway: "subway_entrance", name: "Entrance A" } },
      { type: "node", id: 2, lat: 3, lon: 4, tags: { railway: "station", station: "subway", name: "Station X" } },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ elements }),
      })
    );

    const res = await fetchStationEntrances(...nextBbox());
    expect(res.length).toBe(2);
    expect(res.find((n) => n.id === 1)?.kind).toBe("entrance");
    expect(res.find((n) => n.id === 2)?.kind).toBe("station");
  });

  it("reuses cached entrances for contained repeat bboxes without sharing mutations", async () => {
    const elements = [
      { type: "node", id: 11, lat: 10, lon: 20, tags: { railway: "subway_entrance", name: "Entrance B" } },
      { type: "node", id: 12, lat: 11, lon: 21, tags: { railway: "station", station: "subway", name: "Station Y" } },
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ elements }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const [south, west, north, east] = nextBbox();
    const first = await fetchStationEntrances(south, west, north, east);
    first[0].name = "Mutated";
    first.push({ id: -1, lat: 0, lon: 0, kind: "station" });

    const second = await fetchStationEntrances(
      south + 0.001,
      west + 0.001,
      north - 0.001,
      east - 0.001
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second).toEqual([
      { id: 11, lat: 10, lon: 20, name: "Entrance B", kind: "entrance" },
      { id: 12, lat: 11, lon: 21, name: "Station Y", kind: "station" },
    ]);
  });
});

// ── Canopy (A7) ───────────────────────────────────────────────────────────────

describe("fetchCanopyAround", () => {
  function canopyResponse(elements: unknown[]) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ elements }),
    });
  }

  it("asks for the four canopy tag families and nothing else", () => {
    const fetchMock = canopyResponse([]);
    vi.stubGlobal("fetch", fetchMock);
    const [south, west] = nextBbox();

    return fetchCanopyAround(west, south, 120).then(() => {
      const body = decodeURIComponent(String(fetchMock.mock.calls[0][1]?.body));
      expect(body).toContain('node["natural"="tree"]');
      expect(body).toContain('way["natural"="tree_row"]');
      expect(body).toContain('way["natural"="wood"]');
      expect(body).toContain('way["landuse"="forest"]');
      // Buildings come from their own call; duplicating them here would double the
      // payload of every canopy fetch against a shared public service.
      expect(body).not.toContain('["building"]');
    });
  });

  it("keeps tree tags as raw strings for the crown model to interpret", async () => {
    vi.stubGlobal(
      "fetch",
      canopyResponse([
        {
          type: "node",
          id: 7001,
          lat: 40.0,
          lon: -74.0,
          tags: { natural: "tree", height: "12 m", leaf_type: "broadleaved", species: "Tilia" },
        },
      ])
    );
    const [south, west] = nextBbox();
    const canopy = await fetchCanopyAround(west, south, 120);

    expect(canopy).toEqual([
      {
        id: 7001,
        kind: "tree",
        points: [[-74.0, 40.0]],
        // `species` is dropped: the model has no use for it, and carrying it would
        // imply the crown radius is derived per-species when it is not.
        tags: {
          height: "12 m",
          diameter_crown: undefined,
          leaf_type: "broadleaved",
          leaf_cycle: undefined,
        },
      },
    ]);
  });

  it("keeps a tree row as its centreline", async () => {
    vi.stubGlobal(
      "fetch",
      canopyResponse([
        {
          type: "way",
          id: 7002,
          tags: { natural: "tree_row" },
          geometry: [
            { lat: 40.0, lon: -74.0 },
            { lat: 40.0, lon: -73.999 },
          ],
        },
      ])
    );
    const [south, west] = nextBbox();
    const [row] = await fetchCanopyAround(west, south, 120);

    expect(row.kind).toBe("tree_row");
    expect(row.points).toHaveLength(2);
  });

  it("closes a woodland way and drops one that cannot be closed", async () => {
    vi.stubGlobal(
      "fetch",
      canopyResponse([
        {
          type: "way",
          id: 7003,
          tags: { natural: "wood" },
          geometry: [
            { lat: 40.0, lon: -74.0 },
            { lat: 40.0, lon: -73.999 },
            { lat: 40.001, lon: -73.999 },
          ],
        },
        // Two points cannot bound an area; closing it would emit a degenerate ring.
        {
          type: "way",
          id: 7004,
          tags: { landuse: "forest" },
          geometry: [
            { lat: 41.0, lon: -74.0 },
            { lat: 41.0, lon: -73.999 },
          ],
        },
      ])
    );
    const [south, west] = nextBbox();
    const canopy = await fetchCanopyAround(west, south, 120);

    expect(canopy).toHaveLength(1);
    expect(canopy[0].id).toBe(7003);
    expect(canopy[0].points[0]).toEqual(canopy[0].points[canopy[0].points.length - 1]);
  });

  it("serves a contained bbox from cache rather than re-fetching", async () => {
    const fetchMock = canopyResponse([]);
    vi.stubGlobal("fetch", fetchMock);
    const [south, west] = nextBbox();

    await fetchCanopyAround(west, south, 240);
    await fetchCanopyAround(west, south, 60);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands back a copy, so a caller cannot poison the cache", async () => {
    vi.stubGlobal(
      "fetch",
      canopyResponse([
        { type: "node", id: 7005, lat: 40.0, lon: -74.0, tags: { natural: "tree" } },
      ])
    );
    const [south, west] = nextBbox();

    const first = await fetchCanopyAround(west, south, 120);
    first[0].points[0][0] = 999;
    const second = await fetchCanopyAround(west, south, 120);
    expect(second[0].points[0][0]).toBe(-74.0);
  });
});
