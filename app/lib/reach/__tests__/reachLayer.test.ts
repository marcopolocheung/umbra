import { describe, expect, it } from "vitest";
import { BASEMAP_PALETTES, mapColor } from "../../basemapTheme";
import { reconcileMapLayerOrder } from "../../mapLayerOrder";
import { isBlueDominantShadowPixel } from "../../shadowSampling";
import { shadowPixelAt } from "../../shadowField/__tests__/agreement/harness";
import type { SunReachEdge } from "../../sunReach";
import {
  attachReachLayer,
  REACH_LAYER_IDS,
  REACH_PROVEN_LAYER_ID,
  REACH_SOURCE_ID,
  REACH_UNDECIDED_LAYER_ID,
  REACH_DASH,
  REACH_DIMMED_OPACITY,
  REACH_UNDECIDED_OPACITY,
  REACH_WALK_LAYER_IDS,
  reachFeatures,
  walkFeatures,
} from "../reachLayer";

type Rgb = readonly [number, number, number];
const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
const detected = (c: Rgb) => isBlueDominantShadowPixel(c[0], c[1], c[2]);

// ─── Invariant #5 ─────────────────────────────────────────────────────────────

describe("the reach lines and the shadow predicate (invariant #5)", () => {
  // Drawn above the shadow layer, a line pixel is the line's own colour (casing
  // and ink opaque) or the dash over whatever lies beneath, shaded or not.
  const surfaces = Object.entries(BASEMAP_PALETTES).flatMap(([theme, colors]) =>
    Object.entries(colors)
      .filter(([, c]) => c.startsWith("#"))
      .map(([role, hex]) => ({ name: `${theme} ${role}`, theme: theme as "day" | "night", rgb: rgb(hex) })),
  );
  const over = (line: Rgb, under: Rgb, opacity: number): Rgb =>
    under.map((c, i) => Math.round(line[i] * opacity + c * (1 - opacity))) as unknown as Rgb;

  it("never paints a colour the canvas sampler reads as shadow", () => {
    for (const theme of ["day", "night"] as const) {
      expect(detected(rgb(mapColor(theme, "route")))).toBe(false);
      expect(detected(rgb(mapColor(theme, "casing")))).toBe(false);
    }
  });

  it("the dash never turns a sunlit pixel into shadow", () => {
    for (const s of surfaces) {
      if (detected(s.rgb)) continue;
      const dashed = over(rgb(mapColor(s.theme, "route")), s.rgb, REACH_UNDECIDED_OPACITY);
      expect({ name: s.name, detected: detected(dashed) }).toEqual({ name: s.name, detected: false });
    }
  });

  it("is not blue over shadow either: the region is ink, never a shade signal", () => {
    for (const s of surfaces) {
      for (const t of [0, 0.5, 1]) {
        const shaded = shadowPixelAt(t, s.rgb);
        const dashed = over(rgb(mapColor(s.theme, "route")), shaded, REACH_UNDECIDED_OPACITY);
        expect({ name: s.name, t, detected: detected(dashed) }).toEqual({ name: s.name, t, detected: false });
      }
    }
  });
});

// ─── Features ─────────────────────────────────────────────────────────────────

const nodes = new Map([
  [1, { lat: 40.75, lon: -73.99 }],
  [2, { lat: 40.751, lon: -73.99 }],
  [3, { lat: 40.752, lon: -73.99 }],
]);
const edge = (fromId: number, toId: number, side: "left" | "right"): SunReachEdge => ({ fromId, toId, side, distanceM: 100 });

describe("reachFeatures", () => {
  it("draws one centreline per street, whichever sidewalk or direction reached it", () => {
    const fc = reachFeatures(
      { proven: [edge(1, 2, "left"), edge(2, 1, "left"), edge(1, 2, "right")], undecided: [] },
      nodes,
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.coordinates).toEqual([[-73.99, 40.75], [-73.99, 40.751]]);
  });

  it("a street proven by any sidewalk is proven, never also dashed", () => {
    const fc = reachFeatures({ proven: [edge(2, 1, "right")], undecided: [edge(1, 2, "left"), edge(2, 3, "left")] }, nodes);
    expect(fc.features.map((f) => f.properties)).toEqual([{ state: "proven", lo: 1, hi: 2 }, { state: "undecided", lo: 2, hi: 3 }]);
  });

  it("skips edges whose nodes the graph does not hold (snap nodes)", () => {
    expect(reachFeatures({ proven: [edge(-1, 2, "left")], undecided: [] }, nodes).features).toEqual([]);
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

type ReachMap = Parameters<typeof attachReachLayer>[0];

function fakeMap(style: string[]) {
  const order = [...style];
  const layers = new globalThis.Map<string, { layout: Record<string, unknown>; spec?: unknown }>(
    style.map((id) => [id, { layout: {} }]),
  );
  const sources = new globalThis.Map<string, { data: GeoJSON.FeatureCollection }>();
  let addLayerCalls = 0;
  const map = {
    getSource: (id: string) => {
      const source = sources.get(id);
      return source && { setData: (data: GeoJSON.FeatureCollection) => { source.data = data; } };
    },
    addSource: (id: string, spec: { data: GeoJSON.FeatureCollection }) => sources.set(id, { data: spec.data }),
    addLayer: (layer: { id: string }) => {
      addLayerCalls++;
      order.push(layer.id);
      layers.set(layer.id, { layout: {}, spec: layer });
    },
    getLayer: (id: string) => layers.get(id),
    getLayersOrder: () => [...order],
    moveLayer: (id: string) => {
      order.splice(order.indexOf(id), 1);
      order.push(id);
    },
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout[key] = value;
    },
    setPaintProperty: () => {},
  };
  return {
    map: map as unknown as ReachMap & Parameters<typeof reconcileMapLayerOrder>[0],
    order,
    layers,
    features: () => sources.get(REACH_SOURCE_ID)?.data.features.length,
    addLayerCalls: () => addLayerCalls,
  };
}

describe("walkFeatures (#379)", () => {
  it("draws each step on the sidewalk it takes, and marks where the walk ends", () => {
    const fc = walkFeatures({ nodeIds: [1, 2, 3], sides: ["left", "right"], waits: [], sunSec: 1, arrivalSec: 1 }, nodes);
    expect(fc.features.map((f) => f.properties)).toEqual([{ offset: -4 }, { offset: 4 }, { end: true }]);
    expect(fc.features[2].geometry).toEqual({ type: "Point", coordinates: [-73.99, 40.752] });
  });

  it("marks a round trip's stop, not home, where it ends (H5c)", () => {
    const fc = walkFeatures(
      { nodeIds: [1, 2, 3, 2, 1], sides: ["left", "left", "left", "left"], waits: [], dwell: { atNode: 2, seconds: 600 }, sunSec: 1, arrivalSec: 1 },
      nodes,
    );
    expect(fc.features.filter((f) => f.geometry.type === "LineString")).toHaveLength(4);
    const n3 = nodes.get(3)!;
    expect(fc.features.at(-1)).toMatchObject({ properties: { end: true }, geometry: { type: "Point", coordinates: [n3.lon, n3.lat] } });
  });
});

describe("attachReachLayer", () => {
  it("dims the region while a walk shows and restores it after (#379)", () => {
    const fake = fakeMap(["shadow"]);
    const paint: Record<string, unknown> = {};
    (fake.map as unknown as { setPaintProperty: (id: string, k: string, v: unknown) => void }).setPaintProperty = (id, key, value) => {
      if (key === "line-opacity") paint[id] = value;
    };
    const layer = attachReachLayer(fake.map, { theme: "day" });
    layer.setRegion({ proven: [edge(1, 2, "left")], undecided: [edge(2, 3, "left")] }, nodes);
    layer.setWalk({ nodeIds: [1, 2], sides: ["left"], waits: [], sunSec: 1, arrivalSec: 1 }, nodes);
    expect(paint[REACH_PROVEN_LAYER_ID]).toBe(REACH_DIMMED_OPACITY);
    for (const id of REACH_WALK_LAYER_IDS) expect(fake.layers.get(id)?.layout.visibility).toBe("visible");
    layer.setWalk(null, nodes);
    expect(paint[REACH_PROVEN_LAYER_ID]).toBe(1);
    expect(paint[REACH_UNDECIDED_LAYER_ID]).toBe(REACH_UNDECIDED_OPACITY);
    for (const id of REACH_WALK_LAYER_IDS) expect(fake.layers.get(id)?.layout.visibility).toBe("none");
  });


  it("adds nothing until there is a region to draw", () => {
    const fake = fakeMap(["road", "building", "shadow"]);
    attachReachLayer(fake.map, { theme: "day" }).setRegion(null, null);
    expect(fake.order).toEqual(["road", "building", "shadow"]);
  });

  it("files above the shadow and under the route once the stack is reconciled", () => {
    const fake = fakeMap(["road", "building", "shadow", "nav-route-casing", "nav-route-line", "label"]);
    attachReachLayer(fake.map, { theme: "day" }).setRegion({ proven: [edge(1, 2, "left")], undecided: [] }, nodes);
    reconcileMapLayerOrder(fake.map, ["label"], "shadow");
    expect(fake.order).toEqual(["road", "building", "shadow", ...REACH_LAYER_IDS, "nav-route-casing", "nav-route-line", "label"]);
  });

  it("dashes a stopped-early search's undecided streets sparser than an approximate one's (#381)", () => {
    const fake = fakeMap(["shadow"]);
    const painted: unknown[] = [];
    (fake.map as unknown as { setPaintProperty: (id: string, k: string, v: unknown) => void }).setPaintProperty = (_id, key, value) => {
      if (key === "line-dasharray") painted.push(value);
    };
    const layer = attachReachLayer(fake.map, { theme: "day" });
    layer.setRegion({ proven: [edge(1, 2, "left")], undecided: [edge(2, 3, "left")] }, nodes);
    layer.setOutcome("budget-exhausted");
    layer.setOutcome("budget-exhausted");
    layer.setOutcome("approximate");
    expect(painted).toEqual([[...REACH_DASH["budget-exhausted"]], [...REACH_DASH.approximate]]);
    expect(REACH_DASH["budget-exhausted"]).not.toEqual(REACH_DASH.approximate);
  });

  it("dashes only the undecided layer", () => {
    const fake = fakeMap(["shadow"]);
    attachReachLayer(fake.map, { theme: "day" }).setRegion({ proven: [edge(1, 2, "left")], undecided: [] }, nodes);
    const paint = (id: string) => (fake.layers.get(id)!.spec as { paint: Record<string, unknown> }).paint;
    expect(paint(REACH_PROVEN_LAYER_ID)["line-dasharray"]).toBeUndefined();
    expect(paint(REACH_UNDECIDED_LAYER_ID)["line-dasharray"]).toBeDefined();
  });

  it("stays hidden while disabled (Sun Exposure export) and returns after", () => {
    const fake = fakeMap(["shadow"]);
    const layer = attachReachLayer(fake.map, { theme: "day", enabled: false });
    layer.setRegion({ proven: [edge(1, 2, "left")], undecided: [] }, nodes);
    for (const id of REACH_LAYER_IDS) expect(fake.layers.get(id)?.layout.visibility).toBe("none");
    layer.setEnabled(true);
    for (const id of REACH_LAYER_IDS) expect(fake.layers.get(id)?.layout.visibility).toBe("visible");
  });

  it("updates the data in place and hides every layer when the region empties", () => {
    const fake = fakeMap(["shadow"]);
    const layer = attachReachLayer(fake.map, { theme: "day" });
    layer.setRegion({ proven: [edge(1, 2, "left")], undecided: [] }, nodes);
    layer.setRegion({ proven: [edge(1, 2, "left"), edge(2, 3, "right")], undecided: [] }, nodes);
    expect(fake.addLayerCalls()).toBe(3);
    expect(fake.features()).toBe(2);
    layer.setRegion(null, null);
    for (const id of REACH_LAYER_IDS) expect(fake.layers.get(id)?.layout.visibility).toBe("none");
  });
});
