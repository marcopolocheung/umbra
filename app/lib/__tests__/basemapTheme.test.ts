import type { LayerSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { fixtureBasemapStyle } from "../../../e2e/fixtures/basemapStyle";
import {
  applyBasemapTheme,
  applyOverlayTheme,
  BASEMAP_PALETTES,
  basemapPaint,
  type MapRole,
  mapColor,
  overlayPaint,
  WARMTH_RANGE,
} from "../basemapTheme";
import { BASEMAP_RGB, shadowPixelAt } from "../shadowField/__tests__/agreement/harness";
import { isBlueDominantShadowPixel } from "../shadowSampling";
import type { UiTheme } from "../uiTheme";
import { OUTDOOR_V2_LAYERS } from "./outdoorV2Layers.fixture";

type Rgb = readonly [number, number, number];

const THEMES: UiTheme[] = ["day", "night"];
/** `#rrggbb`, or `rgba(r, g, b, a)` read as its colour: alpha only blends it with others in range. */
const rgb = (color: string): Rgb =>
  (color.startsWith("#")
    ? [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16))
    : color.slice(color.indexOf("(") + 1).split(",").slice(0, 3).map(Number)) as unknown as Rgb;
const warmth = ([r, g, b]: Rgb) => (r + g) / 2 - b;
const luminance = (c: Rgb) => c.reduce((sum, channel, i) => {
  const s = channel / 255;
  return sum + (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
}, 0);
const contrast = (a: Rgb, b: Rgb) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
const detected = (c: Rgb) => isBlueDominantShadowPixel(c[0], c[1], c[2]);
/** The renderer's shadow colour runs from dawn (0) to the day's highest sun (1); rain uses the midpoint. */
const SUN_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

const surfaces = Object.entries(BASEMAP_PALETTES).flatMap(([theme, colors]) =>
  Object.entries(colors).map(([role, hex]) => ({ name: `${theme} ${role}`, color: rgb(hex) }))
);

describe("the basemap palettes and the shadow predicate (invariant #5)", () => {
  it("gives opaque night roads and paths 3:1 and labels 4.5:1 on adjacent ground", () => {
    const night = BASEMAP_PALETTES.night;
    for (const surface of [night.land, night.landuse, night.field, night.wood]) {
      for (const stroke of [night.road, night.path]) {
        expect(contrast(rgb(stroke), rgb(surface))).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(rgb(night.label), rgb(surface))).toBeGreaterThanOrEqual(4.5);
    }
  });
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

  it("moves a dawn shadow's anti-aliased edge by no more than the reference grey does", () => {
    // Full coverage is not the whole story: on a shadow's rim the supersampled edge
    // leaves a pixel part-covered, and a warmer surface needs more coverage before the
    // pixel counts. Hold every colour within 0.05 of the harness's reference grey.
    const firstCounted = (surface: Rgb) => {
      for (let step = 0; step <= 200; step++) {
        if (detected(shadowPixelAt(0, surface, step / 200))) return step / 200;
      }
      return 1;
    };
    const reference = firstCounted(BASEMAP_RGB);
    for (const { name, color } of surfaces) {
      expect({ name, withinReference: firstCounted(color) <= reference + 0.05 }).toEqual({
        name,
        withinReference: true,
      });
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
    expect(paintOf("Residential", "fill-color")).toBe(day.tint);
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

  it("makes night road and label centres opaque and restores their loaded day opacity", () => {
    const calls: Array<[string, string, unknown]> = [];
    const map = {
      getLayer: (id: string) => ({ id }),
      setPaintProperty: (id: string, property: string, value: unknown) => calls.push([id, property, value]),
    };
    const layers = [
      { id: "Road", type: "line", "source-layer": "transportation", paint: { "line-color": "#000000", "line-opacity": 0.45 } },
      { id: "Labels", type: "symbol", "source-layer": "place", paint: { "text-color": "#000000", "text-opacity": 0.6 } },
    ] as LayerSpecification[];
    applyBasemapTheme(map, layers, "night");
    expect(calls).toContainEqual(["Road", "line-opacity", 1]);
    expect(calls).toContainEqual(["Labels", "text-opacity", 1]);
    applyBasemapTheme(map, layers, "day");
    expect(calls).toContainEqual(["Road", "line-opacity", 0.45]);
    expect(calls).toContainEqual(["Labels", "text-opacity", 0.6]);
  });
});

describe("map overlays (R4b)", () => {
  const ROLES: MapRole[] = ["route", "casing", "muted", "sun"];
  const MAP_SURFACES = ["land", "landuse", "field", "wood", "water", "road", "building"] as const;

  it("never draws a blue-dominant overlay, so a route left on screen is never read as shade", () => {
    expect(detected(rgb("#1d6ee0"))).toBe(true); // the pre-2.0 route blue was
    for (const theme of THEMES) {
      for (const role of ROLES) {
        expect({ theme, role, detected: detected(rgb(mapColor(theme, role))) }).toEqual({ theme, role, detected: false });
      }
    }
  });

  it("separates the route from its casing, and the cased line from every map surface, at 3:1", () => {
    for (const theme of THEMES) {
      const line = rgb(mapColor(theme, "route"));
      const casing = rgb(mapColor(theme, "casing"));
      expect(contrast(line, casing)).toBeGreaterThanOrEqual(3);
      for (const surface of MAP_SURFACES) {
        const ground = rgb(BASEMAP_PALETTES[theme][surface]);
        const edge = Math.max(contrast(line, ground), contrast(casing, ground));
        expect({ theme, surface, readable: edge >= 3 }).toEqual({ theme, surface, readable: true });
      }
    }
  });

  it("keeps the cased day route separable over painted shade, from dawn to noon", () => {
    // Bare ink is ~2.4:1 on the dark dawn shade; the paper casing is what carries the
    // line there — the reason the day casing is light rather than dark.
    const line = rgb(mapColor("day", "route"));
    const casing = rgb(mapColor("day", "casing"));
    for (const surface of ["land", "road", "building", "field"] as const) {
      for (const t of SUN_FRACTIONS) {
        const shaded = shadowPixelAt(t, rgb(BASEMAP_PALETTES.day[surface]));
        const edge = Math.max(contrast(line, shaded), contrast(casing, shaded));
        expect({ surface, t, readable: edge >= 3 }).toEqual({ surface, t, readable: true });
      }
    }
  });

  it("paints only Umbra's own layers, with the theme's own map colours", () => {
    const basemapIds = new Set(OUTDOOR_V2_LAYERS.map((l) => l.id));
    for (const theme of THEMES) {
      const own = new Set(ROLES.map((role) => mapColor(theme, role)));
      for (const [id, , color] of overlayPaint(theme)) {
        expect(basemapIds.has(id)).toBe(false);
        expect(own.has(color)).toBe(true);
      }
    }
  });

  it("recolours the overlay layers that exist and skips the rest", () => {
    const calls: string[] = [];
    const map = {
      getLayer: (id: string) => (id === "nav-route-line" ? { id } : undefined),
      setPaintProperty: (id: string, property: string, value: unknown) => calls.push(`${id} ${property} ${value}`),
    };
    applyOverlayTheme(map, "night");
    expect(calls).toEqual([`nav-route-line line-color ${mapColor("night", "route")}`]);
  });
});
