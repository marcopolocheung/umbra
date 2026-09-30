import type { LayerSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { fixtureBasemapStyle } from "../../../e2e/fixtures/basemapStyle";
import { applyBasemapTheme, BASEMAP_PALETTES, basemapPaint, WARMTH_RANGE } from "../basemapTheme";
import { shadowPixelAt } from "../shadowField/__tests__/agreement/harness";
import { isBlueDominantShadowPixel } from "../shadowSampling";
import type { UiTheme } from "../uiTheme";
import { OUTDOOR_V2_LAYERS } from "./outdoorV2Layers.fixture";

type Rgb = readonly [number, number, number];

const THEMES: UiTheme[] = ["day", "night"];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
const warmth = ([r, g, b]: Rgb) => (r + g) / 2 - b;
const detected = (c: Rgb) => isBlueDominantShadowPixel(c[0], c[1], c[2]);
/** The renderer's shadow colour runs from dawn (0) to the day's highest sun (1); rain uses the midpoint. */
const SUN_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

const surfaces = Object.entries(BASEMAP_PALETTES).flatMap(([theme, colors]) =>
  Object.entries(colors).map(([role, hex]) => ({ name: `${theme} ${role}`, color: rgb(hex) }))
);

describe("the basemap palettes and the shadow predicate (invariant #5)", () => {
  it("keeps every colour inside the warmth range the argument rests on", () => {
    for (const { name, color } of surfaces) {
      const w = warmth(color);
      expect({ name, inRange: w >= WARMTH_RANGE.min && w <= WARMTH_RANGE.max }).toEqual({ name, inRange: true });
    }
  });

  it("never reads sunlit ground as shadow", () => {
    for (const { name, color } of surfaces) {
      expect({ name, detected: detected(color) }).toEqual({ name, detected: false });
    }
  });

  it("keeps a shadow detectable on every colour, from dawn to the highest sun", () => {
    for (const { name, color } of surfaces) {
      for (const t of SUN_FRACTIONS) {
        expect({ name, t, detected: detected(shadowPixelAt(t, color)) }).toEqual({ name, t, detected: true });
      }
    }
  });

  it("holds halfway through a paint transition between the two themes", () => {
    // Not a separate property: blending is linear, so the warmth range covers it. This
    // checks the argument instead of trusting it.
    for (const a of surfaces) {
      for (const b of surfaces) {
        const mid = a.color.map((c, i) => Math.round((c + b.color[i]) / 2)) as unknown as Rgb;
        const name = `${a.name} / ${b.name}`;
        expect({ name, sunlit: detected(mid), dawn: detected(shadowPixelAt(0, mid)) }).toEqual({
          name,
          sunlit: false,
          dawn: true,
        });
      }
    }
  });

  it("stops sunlit water reading as shadow, and dawn shadow disappearing on wood", () => {
    // outdoor-v2's street-zoom water, hsl(206, 78%, 75%), and wood, hsl(90, 39%, 80%):
    // the first was a false shadow in full sun, the second lost the dawn shadow.
    expect(detected([143, 194, 240])).toBe(true);
    expect(detected(shadowPixelAt(0, [204, 224, 184]))).toBe(false);
    expect(detected(rgb(BASEMAP_PALETTES.day.water))).toBe(false);
    expect(detected(shadowPixelAt(0, rgb(BASEMAP_PALETTES.day.wood)))).toBe(true);
  });
});

describe("basemapPaint", () => {
  it("replaces every colour outdoor-v2 declares, in both themes", () => {
    for (const theme of THEMES) {
      for (const layer of OUTDOOR_V2_LAYERS) {
        const declared = Object.keys(("paint" in layer && layer.paint) || {});
        expect({ id: layer.id, set: Object.keys(basemapPaint(layer, theme)).sort() }).toEqual({
          id: layer.id,
          set: declared.sort(),
        });
      }
    }
  });

  it("only ever paints with the theme's own palette", () => {
    for (const theme of THEMES) {
      const own = new Set(Object.values(BASEMAP_PALETTES[theme]));
      for (const layer of OUTDOOR_V2_LAYERS) {
        for (const color of Object.values(basemapPaint(layer, theme))) expect(own.has(color)).toBe(true);
      }
    }
  });

  it("classifies the surfaces a route crosses", () => {
    const paintOf = (id: string, property: string) => {
      const layer = OUTDOOR_V2_LAYERS.find((l) => l.id === id);
      if (!layer) throw new Error(`no layer ${id}`);
      return basemapPaint(layer, "day")[property];
    };
    const day = BASEMAP_PALETTES.day;
    expect(paintOf("Background", "background-color")).toBe(day.land);
    expect(paintOf("Road network", "line-color")).toBe(day.road);
    expect(paintOf("Path", "line-color")).toBe(day.path);
    expect(paintOf("Bicycle local", "line-color")).toBe(day.path);
    expect(paintOf("Major railway", "line-color")).toBe(day.rail);
    expect(paintOf("Water", "fill-color")).toBe(day.water);
    expect(paintOf("Park", "fill-color")).toBe(day.field);
    expect(paintOf("Wood", "fill-color")).toBe(day.wood);
    expect(paintOf("Building", "fill-color")).toBe(day.building);
    expect(paintOf("Building", "fill-outline-color")).toBe(day.edge);
    expect(paintOf("Road labels", "text-halo-color")).toBe(day.land);
    expect(paintOf("Lake labels", "text-color")).toBe(day["water-label"]);
  });

  it("recolours the e2e fixture style, so the smoke test runs over the day palette", () => {
    const [background, building] = fixtureBasemapStyle().layers;
    expect(basemapPaint(background, "day")).toEqual({ "background-color": BASEMAP_PALETTES.day.land });
    expect(basemapPaint(building, "day")).toEqual({ "fill-color": BASEMAP_PALETTES.day.building });
  });
});

describe("applyBasemapTheme", () => {
  it("paints the captured layers that still exist, and nothing else", () => {
    const calls: string[] = [];
    const map = {
      getLayer: (id: string) => (id === "gone" ? undefined : { id }),
      setPaintProperty: (id: string, property: string, value: string) => calls.push(`${id} ${property} ${value}`),
    };
    const layers = [
      { id: "Background", type: "background", paint: {} },
      { id: "gone", type: "background", paint: {} },
    ] as LayerSpecification[];
    applyBasemapTheme(map, layers, "night");
    expect(calls).toEqual([`Background background-color ${BASEMAP_PALETTES.night.land}`]);
  });
});
