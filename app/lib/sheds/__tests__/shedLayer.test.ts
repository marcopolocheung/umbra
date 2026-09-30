import { describe, expect, it } from "vitest";
import { BASEMAP_PALETTES } from "../../basemapTheme";
import { isBlueDominantShadowPixel } from "../../shadowSampling";
import { shadowPixelAt } from "../../shadowField/__tests__/agreement/harness";
import {
  SHED_FILL_COLOR,
  SHED_FILL_OPACITY,
  SHED_LAYER_ID,
  SHED_SOURCE_ID,
  attachShedLayer,
} from "../shedLayer";

type Rgb = readonly [number, number, number];

const SHED_FILL_RGB = [1, 3, 5].map((i) => Number.parseInt(SHED_FILL_COLOR.slice(i, i + 2), 16)) as unknown as Rgb;

// ─── Invariant #5 ─────────────────────────────────────────────────────────────

/**
 * What the fill can land on: every solid colour of R4's day and night basemaps. It
 * goes in beneath the buildings and above everything else, so roads and water mix
 * with it too.
 */
const SURFACES: Record<string, Rgb> = Object.fromEntries(
  Object.entries(BASEMAP_PALETTES).flatMap(([theme, colors]) =>
    Object.entries(colors)
      .filter(([, color]) => color.startsWith("#"))
      .map(([role, hex]) => [`${theme} ${role}`, [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))])
  )
) as unknown as Record<string, Rgb>;

const SUN_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];
const OPACITIES = [0.15, SHED_FILL_OPACITY, 0.6];

const underFill = (surface: Rgb, opacity: number): Rgb =>
  surface.map((c, i) => Math.round(SHED_FILL_RGB[i] * opacity + c * (1 - opacity))) as unknown as Rgb;

const detected = (rgb: Rgb) => isBlueDominantShadowPixel(rgb[0], rgb[1], rgb[2]);

describe("the shed fill and the shadow predicate (invariant #5)", () => {
  it("never makes a sunlit surface read as shadow that did not already", () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      if (detected(surface)) continue;
      for (const opacity of OPACITIES) {
        expect({ name, opacity, detected: detected(underFill(surface, opacity)) }).toEqual({
          name,
          opacity,
          detected: false,
        });
      }
    }
  });

  it("never loses a shadow the predicate already saw, from dawn to the highest sun", () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      for (const t of SUN_FRACTIONS) {
        if (!detected(shadowPixelAt(t, surface))) continue;
        for (const opacity of OPACITIES) {
          const shadowed = shadowPixelAt(t, underFill(surface, opacity));
          expect({ name, t, opacity, detected: detected(shadowed) }).toEqual({
            name,
            t,
            opacity,
            detected: true,
          });
        }
      }
    }
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

type Map = Parameters<typeof attachShedLayer>[0];

function fakeMap(style: Array<{ id: string; sourceLayer?: string }>) {
  const order = style.map((l) => l.id);
  const layers = new globalThis.Map<string, { sourceLayer?: string; layout: Record<string, unknown> }>(
    style.map((l) => [l.id, { sourceLayer: l.sourceLayer, layout: {} }]),
  );
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
    addLayer: (layer: { id: string }, beforeId?: string) => {
      addLayerCalls++;
      order.splice(beforeId === undefined ? order.length : order.indexOf(beforeId), 0, layer.id);
      layers.set(layer.id, { layout: {} });
    },
    getLayer: (id: string) => layers.get(id),
    getLayersOrder: () => [...order],
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout[key] = value;
    },
  };

  return {
    map: map as unknown as Map,
    order,
    features: () => sources.get(SHED_SOURCE_ID)?.data.features.length,
    visibility: () => layers.get(SHED_LAYER_ID)?.layout.visibility,
    addLayerCalls: () => addLayerCalls,
  };
}

const STYLE = [
  { id: "landuse", sourceLayer: "landuse" },
  { id: "road", sourceLayer: "transportation" },
  { id: "building", sourceLayer: "building" },
  { id: "label", sourceLayer: "place" },
  { id: "shadow" },
];

const ring: [number, number][] = [
  [-73.985, 40.755],
  [-73.9849, 40.755],
  [-73.9849, 40.7551],
  [-73.985, 40.7551],
  [-73.985, 40.755],
];

describe("attachShedLayer", () => {
  it("adds nothing until it has sheds to draw", () => {
    const fake = fakeMap(STYLE);
    const layer = attachShedLayer(fake.map, { belowLayerId: "shadow", enabled: true });
    layer.setRings([]);
    expect(fake.order).not.toContain(SHED_LAYER_ID);
  });

  it("draws beneath the buildings, above the roads", () => {
    const fake = fakeMap(STYLE);
    attachShedLayer(fake.map, { belowLayerId: "shadow", enabled: true }).setRings([ring]);
    const at = fake.order.indexOf(SHED_LAYER_ID);
    expect(at).toBe(fake.order.indexOf("building") - 1);
    expect(at).toBeGreaterThan(fake.order.indexOf("road"));
    expect(fake.visibility()).toBe("visible");
  });

  it("falls back to beneath the shadow layer in a style with no buildings", () => {
    const fake = fakeMap([{ id: "road", sourceLayer: "transportation" }, { id: "shadow" }]);
    attachShedLayer(fake.map, { belowLayerId: "shadow", enabled: true }).setRings([ring]);
    expect(fake.order).toEqual(["road", SHED_LAYER_ID, "shadow"]);
  });

  it("replaces the drawn sheds without adding a second layer", () => {
    const fake = fakeMap(STYLE);
    const layer = attachShedLayer(fake.map, { belowLayerId: "shadow", enabled: true });
    layer.setRings([ring]);
    layer.setRings([ring, ring]);
    expect(fake.features()).toBe(2);
    expect(fake.addLayerCalls()).toBe(1);
    layer.setRings([]);
    expect(fake.features()).toBe(0);
    expect(fake.visibility()).toBe("none");
  });

  it("stays hidden while disabled, and shows the latest sheds once enabled", () => {
    const fake = fakeMap(STYLE);
    const layer = attachShedLayer(fake.map, { belowLayerId: "shadow", enabled: false });
    layer.setRings([ring]);
    expect(fake.visibility()).not.toBe("visible");
    layer.setEnabled(true);
    expect(fake.visibility()).toBe("visible");
    expect(fake.features()).toBe(1);
    layer.setEnabled(false);
    expect(fake.visibility()).toBe("none");
  });
});
