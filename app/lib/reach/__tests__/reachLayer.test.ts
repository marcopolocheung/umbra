import { describe, expect, it } from "vitest";
import { BASEMAP_PALETTES, mapColor } from "../../basemapTheme";
import { isBlueDominantShadowPixel } from "../../shadowSampling";
import { shadowPixelAt } from "../../shadowField/__tests__/agreement/harness";
import type { SunReachEdge } from "../../sunReach";
import {
  attachReachLayer,
  REACH_PROVEN_LAYER_ID,
  REACH_PROVEN_OPACITY,
  REACH_SOURCE_ID,
  REACH_UNDECIDED_LAYER_ID,
  REACH_UNDECIDED_OPACITY,
  reachFeatures,
} from "../reachLayer";

type Rgb = readonly [number, number, number];
const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
const detected = (c: Rgb) => isBlueDominantShadowPixel(c[0], c[1], c[2]);

// ─── Invariant #5 ─────────────────────────────────────────────────────────────

describe("the reach lines and the shadow predicate (invariant #5)", () => {
  // Beneath the buildings, the lines can land on any solid basemap colour.
  const surfaces = Object.entries(BASEMAP_PALETTES).flatMap(([theme, colors]) =>
    Object.entries(colors)
      .filter(([, c]) => c.startsWith("#"))
      .map(([role, hex]) => ({ name: `${theme} ${role}`, theme: theme as "day" | "night", rgb: rgb(hex) })),
  );
  const under = (line: Rgb, surface: Rgb, opacity: number): Rgb =>
    surface.map((c, i) => Math.round(line[i] * opacity + c * (1 - opacity))) as unknown as Rgb;

  for (const opacity of [REACH_UNDECIDED_OPACITY, REACH_PROVEN_OPACITY]) {
    it(`at opacity ${opacity}, never makes sun read as shadow, nor loses a shadow the predicate saw`, () => {
      for (const s of surfaces) {
        const line = rgb(mapColor(s.theme, "route"));
        const lined = under(line, s.rgb, opacity);
        if (!detected(s.rgb)) expect({ name: s.name, detected: detected(lined) }).toEqual({ name: s.name, detected: false });
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          if (!detected(shadowPixelAt(t, s.rgb))) continue;
          expect({ name: s.name, t, detected: detected(shadowPixelAt(t, lined)) }).toEqual({ name: s.name, t, detected: true });
        }
      }
    });
  }
});

// ─── Features ─────────────────────────────────────────────────────────────────

const nodes = new Map([
  [1, { lat: 40.75, lon: -73.99 }],
  [2, { lat: 40.751, lon: -73.99 }],
  [3, { lat: 40.752, lon: -73.99 }],
]);
const edge = (fromId: number, toId: number, side: "left" | "right"): SunReachEdge => ({ fromId, toId, side, distanceM: 100 });

describe("reachFeatures", () => {
  it("tags proven and undecided edges and offsets each sidewalk to its own side", () => {
    const fc = reachFeatures({ proven: [edge(1, 2, "left")], undecided: [edge(2, 3, "right")] }, nodes);
    expect(fc.features.map((f) => f.properties)).toEqual([
      { state: "proven", offset: -3 },
      { state: "undecided", offset: 3 },
    ]);
    expect(fc.features[0].geometry.coordinates).toEqual([[-73.99, 40.75], [-73.99, 40.751]]);
  });

  it("skips edges whose nodes the graph does not hold (snap nodes)", () => {
    expect(reachFeatures({ proven: [edge(-1, 2, "left")], undecided: [] }, nodes).features).toEqual([]);
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

type ReachMap = Parameters<typeof attachReachLayer>[0];

function fakeMap(style: Array<{ id: string; sourceLayer?: string }>) {
  const order = style.map((l) => l.id);
  const layers = new globalThis.Map<string, { sourceLayer?: string; layout: Record<string, unknown>; spec?: unknown }>(
    style.map((l) => [l.id, { sourceLayer: l.sourceLayer, layout: {} }]),
  );
  const sources = new globalThis.Map<string, { data: GeoJSON.FeatureCollection }>();
  let addLayerCalls = 0;
  const map = {
    getSource: (id: string) => {
      const source = sources.get(id);
      return source && { setData: (data: GeoJSON.FeatureCollection) => { source.data = data; } };
    },
    addSource: (id: string, spec: { data: GeoJSON.FeatureCollection }) => sources.set(id, { data: spec.data }),
    addLayer: (layer: { id: string }, beforeId?: string) => {
      addLayerCalls++;
      order.splice(beforeId === undefined ? order.length : order.indexOf(beforeId), 0, layer.id);
      layers.set(layer.id, { layout: {}, spec: layer });
    },
    getLayer: (id: string) => layers.get(id),
    getLayersOrder: () => [...order],
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout[key] = value;
    },
    setPaintProperty: () => {},
  };
  return {
    map: map as unknown as ReachMap,
    order,
    layers,
    features: () => sources.get(REACH_SOURCE_ID)?.data.features.length,
    addLayerCalls: () => addLayerCalls,
  };
}

const STYLE = [
  { id: "road", sourceLayer: "transportation" },
  { id: "building", sourceLayer: "building" },
  { id: "shadow" },
];

describe("attachReachLayer", () => {
  it("adds nothing until there is a region to draw", () => {
    const fake = fakeMap(STYLE);
    attachReachLayer(fake.map, { belowLayerId: "shadow", theme: "day" }).setRegion(null, null);
    expect(fake.order).toEqual(["road", "building", "shadow"]);
  });

  it("draws both layers beneath the buildings, never above the shadow layer", () => {
    const fake = fakeMap(STYLE);
    attachReachLayer(fake.map, { belowLayerId: "shadow", theme: "day" }).setRegion(
      { proven: [edge(1, 2, "left")], undecided: [edge(2, 3, "left")] },
      nodes,
    );
    expect(fake.order).toEqual(["road", REACH_PROVEN_LAYER_ID, REACH_UNDECIDED_LAYER_ID, "building", "shadow"]);
  });

  it("dashes only the undecided layer", () => {
    const fake = fakeMap(STYLE);
    attachReachLayer(fake.map, { belowLayerId: "shadow", theme: "day" }).setRegion(
      { proven: [edge(1, 2, "left")], undecided: [] },
      nodes,
    );
    const paint = (id: string) => (fake.layers.get(id)!.spec as { paint: Record<string, unknown> }).paint;
    expect(paint(REACH_PROVEN_LAYER_ID)["line-dasharray"]).toBeUndefined();
    expect(paint(REACH_UNDECIDED_LAYER_ID)["line-dasharray"]).toEqual([2, 2]);
  });

  it("updates the data in place and hides both layers when the region empties", () => {
    const fake = fakeMap(STYLE);
    const layer = attachReachLayer(fake.map, { belowLayerId: "shadow", theme: "day" });
    layer.setRegion({ proven: [edge(1, 2, "left")], undecided: [] }, nodes);
    layer.setRegion({ proven: [edge(1, 2, "left"), edge(2, 3, "right")], undecided: [] }, nodes);
    expect(fake.addLayerCalls()).toBe(2);
    expect(fake.features()).toBe(2);
    layer.setRegion(null, null);
    expect(fake.layers.get(REACH_PROVEN_LAYER_ID)?.layout.visibility).toBe("none");
    expect(fake.layers.get(REACH_UNDECIDED_LAYER_ID)?.layout.visibility).toBe("none");
  });
});
