import { describe, expect, it } from "vitest";
import { BASEMAP_PALETTES } from "../../basemapTheme";
import type { StreetShadeGroup, StreetTypeSegment } from "../../navigationData/signatureRoute";
import { shadowPixelAt } from "../../shadowField/__tests__/agreement/harness";
import { isBlueDominantShadowPixel } from "../../shadowSampling";
import type { UiTheme } from "../../uiTheme";
import {
  STREET_TYPE_LAYER_ID,
  STREET_TYPE_SOURCE_ID,
  attachStreetTypeLayer,
  offsetToSidewalk,
  streetTypeColor,
} from "../streetTypeLayer";

type Rgb = readonly [number, number, number];
const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
const detected = (c: Rgb) => isBlueDominantShadowPixel(c[0], c[1], c[2]);
const GROUPS: StreetShadeGroup[] = [1, 2, 3, 4];
const THEMES: UiTheme[] = ["day", "night"];

// ─── Invariant #5 ─────────────────────────────────────────────────────────────

describe("street type colours and the shadow predicate (invariant #5)", () => {
  it("never reads as shadow on its own", () => {
    for (const theme of THEMES)
      for (const group of GROUPS)
        expect({ theme, group, detected: detected(rgb(streetTypeColor(theme, group))) }).toEqual({
          theme,
          group,
          detected: false,
        });
  });

  it("keeps a shadow drawn over it reading as shadow, wherever the basemap already did", () => {
    // The line is opaque, so it replaces the surface beneath the shadow layer.
    // Wherever a shadow over the basemap was detected, it must stay detected.
    for (const theme of THEMES) {
      const surfaces = Object.values(BASEMAP_PALETTES[theme]).filter((c) => c.startsWith("#")).map(rgb);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        if (!surfaces.some((surface) => detected(shadowPixelAt(t, surface)))) continue;
        for (const group of GROUPS) {
          const shadowed = shadowPixelAt(t, rgb(streetTypeColor(theme, group)));
          expect({ theme, t, group, detected: detected(shadowed) }).toEqual({ theme, t, group, detected: true });
        }
      }
    }
  });
});

// ─── Geometry ─────────────────────────────────────────────────────────────────

describe("offsetToSidewalk", () => {
  const segment = (side: "left" | "right"): StreetTypeSegment => ({
    from: [-73.985, 40.755],
    to: [-73.985, 40.756], // due north
    side,
    type: 0,
    group: 1,
  });

  it("moves the line a few metres to the walked side", () => {
    // Walking north, left is west (smaller longitude), right is east.
    const [[leftX]] = offsetToSidewalk(segment("left"));
    const [[rightX]] = offsetToSidewalk(segment("right"));
    expect(leftX).toBeLessThan(-73.985);
    expect(rightX).toBeGreaterThan(-73.985);
    const metres = (-73.985 - leftX) * 111_320 * Math.cos((40.7555 * Math.PI) / 180);
    expect(metres).toBeCloseTo(6, 1);
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

type Map = Parameters<typeof attachStreetTypeLayer>[0];

function fakeMap(style: Array<{ id: string; sourceLayer?: string }>) {
  const order = style.map((l) => l.id);
  const layers = new globalThis.Map<
    string,
    { sourceLayer?: string; layout: Record<string, unknown>; paint: Record<string, unknown> }
  >(style.map((l) => [l.id, { sourceLayer: l.sourceLayer, layout: {}, paint: {} }]));
  const sources = new globalThis.Map<string, { data: GeoJSON.FeatureCollection }>();
  let addLayerCalls = 0;
  const map = {
    getSource: (id: string) => {
      const source = sources.get(id);
      return source && { setData: (data: GeoJSON.FeatureCollection) => { source.data = data; } };
    },
    addSource: (id: string, spec: { data: GeoJSON.FeatureCollection }) => {
      sources.set(id, { data: spec.data });
    },
    addLayer: (layer: { id: string; paint: Record<string, unknown> }, beforeId?: string) => {
      addLayerCalls++;
      order.splice(beforeId === undefined ? order.length : order.indexOf(beforeId), 0, layer.id);
      layers.set(layer.id, { layout: {}, paint: { ...layer.paint } });
    },
    getLayer: (id: string) => layers.get(id),
    getLayersOrder: () => [...order],
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout[key] = value;
    },
    setPaintProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.paint[key] = value;
    },
  };
  return {
    map: map as unknown as Map,
    order,
    features: () => sources.get(STREET_TYPE_SOURCE_ID)?.data.features,
    visibility: () => layers.get(STREET_TYPE_LAYER_ID)?.layout.visibility,
    color: () => layers.get(STREET_TYPE_LAYER_ID)?.paint["line-color"],
    addLayerCalls: () => addLayerCalls,
  };
}

const STYLE = [
  { id: "road", sourceLayer: "transportation" },
  { id: "building", sourceLayer: "building" },
  { id: "shadow" },
];

const seg: StreetTypeSegment = { from: [-73.985, 40.755], to: [-73.984, 40.756], side: "left", type: 6, group: 3 };

describe("attachStreetTypeLayer", () => {
  it("adds nothing until it has segments to draw", () => {
    const fake = fakeMap(STYLE);
    attachStreetTypeLayer(fake.map, { belowLayerId: "shadow", enabled: true, theme: "day" }).setSegments([]);
    expect(fake.order).not.toContain(STREET_TYPE_LAYER_ID);
  });

  it("draws beneath the buildings and the shadow layer, tagged with each segment's group", () => {
    const fake = fakeMap(STYLE);
    attachStreetTypeLayer(fake.map, { belowLayerId: "shadow", enabled: true, theme: "day" }).setSegments([seg]);
    expect(fake.order.indexOf(STREET_TYPE_LAYER_ID)).toBe(fake.order.indexOf("building") - 1);
    expect(fake.features()?.[0].properties).toEqual({ group: 3 });
    expect(fake.visibility()).toBe("visible");
  });

  it("stays hidden while disabled, and replaces segments without a second layer", () => {
    const fake = fakeMap(STYLE);
    const layer = attachStreetTypeLayer(fake.map, { belowLayerId: "shadow", enabled: false, theme: "day" });
    layer.setSegments([seg]);
    expect(fake.visibility()).not.toBe("visible");
    layer.setEnabled(true);
    layer.setSegments([seg, seg]);
    expect(fake.features()).toHaveLength(2);
    expect(fake.addLayerCalls()).toBe(1);
    layer.setSegments([]);
    expect(fake.visibility()).toBe("none");
  });

  it("recolours for the night basemap", () => {
    const fake = fakeMap(STYLE);
    const layer = attachStreetTypeLayer(fake.map, { belowLayerId: "shadow", enabled: true, theme: "day" });
    layer.setSegments([seg]);
    expect(JSON.stringify(fake.color())).toContain(streetTypeColor("day", 3));
    layer.setTheme("night");
    expect(JSON.stringify(fake.color())).toContain(streetTypeColor("night", 3));
  });
});
