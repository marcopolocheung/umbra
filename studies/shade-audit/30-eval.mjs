#!/usr/bin/env node
/**
 * S1 stage 3 — the audit itself.
 *
 * For each block and each instant of a date × hour grid, compute three answers
 * and compare:
 *
 * - **Truth**: a DDA ray march over the 2017 LiDAR highest-hit surface (stage
 *   2), receiver at bare-earth + 1.0 m, toward the sun, up to 400 m. Every
 *   shadowed pixel is attributed to its blocking cell's 2021 land-cover class —
 *   tree canopy (1) or building (5) — which is the building-only vs canopy
 *   split the brief asks for.
 * - **Umbra rendered mask**: the app's own `buildShadowIndexFor` over the
 *   static-shard building prisms — the same triangles the WebGL renderer
 *   rasterizes, point-sampled at cell centres. Buildings only: the rendered
 *   shadow layer has never drawn a tree (that is the gap this audit measures).
 * - **Umbra field** (what routing reads): the bundled
 *   `createGeometryShadowField` with the static prism provider and the CHMv2
 *   raster canopy provider (source.coop, cached once per block), answering
 *   `sampleEdges` for every sidewalk edge of the block's street shards — and
 *   a buildings-only twin with the canopy providers removed, whose error
 *   against the first is the measured canopy delta.
 *
 * Outputs, cached per block as JSON under cache/results/:
 * - per (instant, pixel): nothing stored — aggregates only;
 * - mask IoU (overall; building-attributed; canopy-attributed) per instant;
 * - per sidewalk segment per instant: truth fraction (all / building-only /
 *   canopy share), field fraction (with/without canopy), left and right;
 * - hourly stats derived in stage 40's note.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import SunCalc from "suncalc";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache");
const BUNDLE = join(CACHE, "bundle");

const {
  createGeometryShadowField,
  staticPrismProvider,
  edgeSampleCount,
  sidewalkOffsets,
} = await import(join(BUNDLE, "shadowField", "ShadowField.mjs"));
const { prismsFromFootprints } = await import(join(BUNDLE, "shadowField", "geometry.mjs"));
const { buildShadowIndexFor, prepareShadowCasters } = await import(join(BUNDLE, "shadowField", "shadowIndex.mjs"));
const { createCanopyHeightField } = await import(join(BUNDLE, "shadowField", "canopyRasterField.mjs"));

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const { blocks } = JSON.parse(readFileSync(join(HERE, "blocks.json"), "utf8"));
const acquisition = JSON.parse(readFileSync(join(CACHE, "acquisition.json"), "utf8"));

/** The date × hour grid: solstices + equinox × five local clock hours.
 * `tz` is the UTC offset in hours, so UTC = local − tz. */
const GRID = [];
for (const [label, [y, m, d], tz] of [
  ["jun-solstice", [2026, 6, 21], -4],
  ["mar-equinox", [2026, 3, 20], -4],
  ["dec-solstice", [2026, 12, 21], -5],
]) {
  for (const hour of [8, 10, 12, 14, 16]) {
    GRID.push({ label, when: new Date(Date.UTC(y, m - 1, d, hour - tz, 0, 0)), hour });
  }
}

const RECEIVER_M = 1.0;   // pedestrian body height above bare earth
const MARCH_CAP_M = 400;  // same cap as the app's canopy march and QUERY_PAD_M

// ---------------------------------------------------------------------------
// Per-block geometry loading
// ---------------------------------------------------------------------------

/** Block frame: local east/north metres + cell size + LiDAR grids. */
function loadSurface(slug) {
  const stem = join(CACHE, "lidar-surface", slug);
  const meta = JSON.parse(readFileSync(`${stem}.json`, "utf8"));
  const n = meta.n;
  return {
    ...meta,
    top: new Float32Array(readFileSync(`${stem}-top.bin`).buffer),
    ground: new Float32Array(readFileSync(`${stem}-ground.bin`).buffer),
  };
}

/** Land-cover window (2021, 6 in) in EPSG:2263 feet — class lookup per cell. */
function loadLandcover(slug) {
  const stem = join(CACHE, "landcover", slug);
  const meta = JSON.parse(readFileSync(`${stem}.json`, "utf8"));
  const [h, w] = meta.shape;
  const data = new Uint8Array(readFileSync(`${stem}.bin`).buffer);
  const [west, bottom, east, north] = meta.bounds_2263;
  const ft = 1200 / 3937; // metres per US survey foot
  return { data, h, w, west, bottom, east, north, resFt: (east - west) / w, ft };
}

/** 2263 feet coordinates of the block centre (LiDAR frame anchor). */
function centre2263(lng, lat) {
  // A tiny pyproj round trip, done once per block via rasterio's Python.
  const out = execFileSync(
    "python3",
    ["-c", `from rasterio.warp import transform as wt
x, y = wt("EPSG:4326", "EPSG:2263", [${lng}], [${lat}])
print(x[0], y[0])`],
    { encoding: "utf8" },
  ).trim().split(/\s+/).map(Number);
  return { cx: out[0], cy: out[1] };
}

/** Umbra building prisms for a block, from the cached SHA-verified shards. */
function loadUmbraPrisms(slug) {
  const manifest = JSON.parse(
    readFileSync(join(CACHE, "umbra-shards", "..", "..", "umbra-shards", "manifest-placeholder"), "utf8"),
  );
  return manifest;
}

/** Building prisms + sidewalk edges from the cached nav shards. */
function loadNavGeometry(block, surface) {
  // Re-select shards exactly as stage 1 did, from the same manifest.
  const manifest = JSON.parse(
    readFileSync(
      join(process.env.NAVIGATION_LOCAL_ROOT || join(process.env.HOME, "shade-prep-data-nyc-navigation/normalized/nyc-2026-09-18-9f2924750af1"), "navigation/nyc/nyc-2026-09-18-9f2924750af1/manifest.json"),
      "utf8",
    ),
  );
  const bbox = {
    south: block.lat - 125 / 111320,
    north: block.lat + 125 / 111320,
    west: block.lng - 125 / (111320 * Math.cos((block.lat * Math.PI) / 180)),
    east: block.lng + 125 / (111320 * Math.cos((block.lat * Math.PI) / 180)),
  };
  const overlaps = (ref) =>
    ref.geometryBounds.south <= bbox.north && ref.geometryBounds.north >= bbox.south &&
    ref.geometryBounds.west <= bbox.east && ref.geometryBounds.east >= bbox.west;
  // The field pads its own query by QUERY_PAD_M (400) beyond the sample region,
  // so the provider's coverage must span surface extent (±extM, 675 m) and the
  // shard selection reach must cover it too.
  const pad = 675 / 111320;
  const withinReach = (ref) =>
    ref.geometryBounds.south - pad <= bbox.north && ref.geometryBounds.north + pad >= bbox.south &&
    ref.geometryBounds.west - pad <= bbox.east && ref.geometryBounds.east + pad >= bbox.west;
  const buildings = [];
  for (const ref of manifest.buildingShards.filter(withinReach)) {
    const shard = JSON.parse(readFileSync(join(CACHE, "umbra-shards", ref.key), "utf8"));
    for (const b of shard.buildings) {
      const rings = b.rings.filter((ring) => ring.length >= 4);
      if (rings.length === 0) continue;
      buildings.push({ heightM: b.heightM ?? 10, rings });
    }
  }
  const nodeById = new Map();
  const edges = [];
  for (const ref of manifest.streetShards.filter(overlaps)) {
    const shard = JSON.parse(readFileSync(join(CACHE, "umbra-shards", ref.key), "utf8"));
    for (const node of shard.nodes) nodeById.set(node.id, node);
    for (const e of shard.edges) edges.push(e);
  }
  // Deduplicate edges across shards (each side appears as its own edge id).
  const seen = new Set();
  const sidewalkEdges = [];
  for (const e of edges) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) continue;
    const midLng = (a.lon + b.lon) / 2;
    const midLat = (a.lat + b.lat) / 2;
    // Only edges whose midpoint sits in the central 250 m block.
    const dLat = (midLat - surface.centre[1]) * 111320;
    const dLng = (midLng - surface.centre[0]) * 111320 * Math.cos((surface.centre[1] * Math.PI) / 180);
    if (Math.abs(dLng) > 125 || Math.abs(dLat) > 125) continue;
    // Skip non-walkable classes the router itself would not price.
    const hw = e.tags?.highway;
    if (["motorway", "trunk", "motorway_link", "trunk_link", "proposed", "construction", "raceway"].includes(hw)) continue;
    sidewalkEdges.push({ from: [a.lon, a.lat], to: [b.lon, b.lat], id: e.id, distanceM: e.distanceM, highway: hw });
  }
  return { buildings, edges: sidewalkEdges };
}

// ---------------------------------------------------------------------------
// Canopy raster (CHMv2 via source.coop), cached once per block
// ---------------------------------------------------------------------------

async function canopyPatchFor(block, surface) {
  const stem = join(CACHE, "canopy", block.slug);
  if (existsSync(`${stem}.json`) && existsSync(`${stem}.bin`)) {
    const meta = JSON.parse(readFileSync(`${stem}.json`, "utf8"));
    return { ...meta, heights: new Uint8Array(readFileSync(`${stem}.bin`).buffer) };
  }
  // The app's own store, reading the published COGs exactly as the app does.
  const { createCanopyTileStore } = await import(join(BUNDLE, "canopyRaster", "canopyTileStore.mjs"));
  const store = createCanopyTileStore({});
  const extM = surface.extM;
  const [lngC, latC] = surface.centre;
  const dLat = extM / 111320;
  const dLng = extM / (111320 * Math.cos((latC * Math.PI) / 180));
  const patch = await store.read([lngC - dLng, latC - dLat, lngC + dLng, latC + dLat], {
    targetGroundRes: 2, // route-priority reads use the app default; 2 m is the store's route target
    priority: "route",
  });
  mkdirSync(join(CACHE, "canopy"), { recursive: true });
  writeFileSync(`${stem}.bin`, patch.heights);
  writeFileSync(
    `${stem}.json`,
    `${JSON.stringify({
      width: patch.width,
      height: patch.height,
      bbox: patch.bbox,
      metresPerPixel: patch.metresPerPixel,
      validFraction: patch.validFraction,
      maxHeightM: patch.maxHeightM,
      quadkeys: patch.quadkeys,
    })}\n`,
  );
  return { ...patch };
}

// ---------------------------------------------------------------------------
// Truth march (LiDAR surface, attributed)
// ---------------------------------------------------------------------------

/**
 * March one receiver toward the sun over the LiDAR surface.
 * Returns { shadow: 0|1, blocker: "building"|"canopy"|"other"|null }.
 * Cell indexing identical to stage 2: row 0 = north, 1 m cells, ±extM frame.
 *
 * `skipCanopy` marches *through* canopy-attributed cells: the answer is then
 * "would this point be shadowed with the trees removed". That is the honest
 * building-only truth — the first-blocker attribution alone would drop a point
 * whose ray meets a street tree before the tower behind it.
 */
function truthAt(surface, landcover, centre, eastM, northM, azimuth, altitude, skipCanopy = false) {
  const n = surface.n;
  const extM = surface.extM;
  const cellM = surface.cellM;
  if (altitude <= 0) return { shadow: 1, blocker: "night" };
  const rayEast = -Math.sin(azimuth);  // toward the sun (SunCalc azimuth convention)
  const rayNorth = -Math.cos(azimuth);
  const tanAlt = Math.tan(altitude);
  if (!(tanAlt > 0) || !Number.isFinite(tanAlt)) return { shadow: 0, blocker: null };

  const toCell = (e, no) => {
    if (Math.abs(e) >= extM || Math.abs(no) >= extM) return -1;
    return Math.floor((no + extM) / cellM) * n + Math.floor((e + extM) / cellM);
  };
  const receiverGround = surface.ground[toCell(eastM, northM)] ?? 0;
  const z0 = receiverGround + RECEIVER_M;

  // DDA over integer grid cells (the app's own march convention: grid indices,
  // t-values in ground metres, cell tested between entry and exit).
  const gridX = Math.floor((eastM + extM) / cellM);
  const gridY = Math.floor((extM - northM) / cellM);
  const cellOf = (gx, gy) => (gx < 0 || gx >= n || gy < 0 || gy >= n) ? -1 : gy * n + gx;
  const stepE = Math.sign(rayEast);
  const stepN = Math.sign(rayNorth);
  const nextXE = stepE > 0 ? (gridX + 1) * cellM - extM : gridX * cellM - extM;
  const nextYN = stepN > 0 ? extM - gridY * cellM : extM - (gridY + 1) * cellM;
  let tMaxE = stepE === 0 ? Infinity : Math.abs((nextXE - eastM) / rayEast);
  let tMaxN = stepN === 0 ? Infinity : Math.abs((nextYN - northM) / rayNorth);
  const tDeltaE = stepE === 0 ? Infinity : cellM / Math.abs(rayEast);
  const tDeltaN = stepN === 0 ? Infinity : cellM / Math.abs(rayNorth);
  let gx = gridX;
  let gy = gridY;
  let entered = 0;
  for (let i = 0; i < 4000; i++) {
    const leave = Math.min(tMaxE, tMaxN);
    if (entered > 0) {
      const idx = cellOf(gx, gy);
      if (idx < 0) return { shadow: 0, blocker: null }; // left the surface
      const top = surface.top[idx];
      const rayLow = z0 + entered * tanAlt;
      if (Number.isFinite(top) && rayLow < top) {
        const cellE = (gx + 0.5) * cellM - extM;
        const cellN = extM - (gy + 0.5) * cellM;
        const blocker = landcoverClass(landcover, centre, cellE, cellN);
        if (!(skipCanopy && blocker === "canopy")) return { shadow: 1, blocker };
      }
    }
    if (leave > MARCH_CAP_M) return { shadow: 0, blocker: null };
    if (tMaxE === tMaxN) { gx += stepE; gy += stepN; entered = tMaxE; tMaxE += tDeltaE; tMaxN += tDeltaN; }
    else if (tMaxE < tMaxN) { gx += stepE; entered = tMaxE; tMaxE += tDeltaE; }
    else { gy += stepN; entered = tMaxN; tMaxN += tDeltaN; }
  }
  return { shadow: 0, blocker: null };
}

/** Land-cover class at a local-frame cell, "building" | "canopy" | "other". */
/** Attribution search radius around a blocking cell, metres. */
const ATTRIBUTION_RADIUS_M = 3;

/**
 * Land-cover class of the caster at a blocking cell: "building" | "canopy" | "other".
 *
 * The blocking cell's own pixel is a poor answer. The 2017 LiDAR and the 2021
 * land cover disagree by a metre or two at every facade (lean, roof overhang,
 * registration), so a ray that grazes a building's top edge usually lands on a
 * sidewalk or road pixel. Probing this study's first run showed 70–82% of
 * single-pixel "other" blockers sat within 3 m of a building pixel.
 *
 * So the caster is the dominant of building vs canopy pixels within
 * `ATTRIBUTION_RADIUS_M`, sampled every ~0.3 m. "other" remains only where
 * neither class is near — elevated roadways, sheds, poles.
 */
function landcoverClass(landcover, centre, eastM, northM) {
  const xFt = centre.cx + eastM / landcover.ft;
  const yFt = centre.cy + northM / landcover.ft;
  const col = Math.floor((xFt - landcover.west) / landcover.resFt);
  const row = Math.floor((landcover.north - yFt) / landcover.resFt);
  const radiusPx = Math.ceil(ATTRIBUTION_RADIUS_M / landcover.ft / landcover.resFt);
  const step = Math.max(1, Math.floor(radiusPx / 10));
  let canopy = 0;
  let building = 0;
  for (let dr = -radiusPx; dr <= radiusPx; dr += step) {
    for (let dc = -radiusPx; dc <= radiusPx; dc += step) {
      if (dr * dr + dc * dc > radiusPx * radiusPx) continue;
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= landcover.h || c < 0 || c >= landcover.w) continue;
      const cls = landcover.data[r * landcover.w + c];
      if (cls === 1) canopy++;
      else if (cls === 5) building++;
    }
  }
  if (canopy === 0 && building === 0) return "other";
  return building >= canopy ? "building" : "canopy";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(join(CACHE, "results"), { recursive: true });
  for (const block of blocks) {
    const outPath = join(CACHE, "results", `${block.slug}.json`);
    if (existsSync(outPath)) {
      process.stderr.write(`results: ${block.slug} cached\n`);
      continue;
    }
    const surface = loadSurface(block.slug);
    const landcover = loadLandcover(block.slug);
    const centre = centre2263(block.lng, block.lat);
    const nav = loadNavGeometry(block, surface);
    process.stderr.write(
      `${block.slug}: ${nav.buildings.length} buildings, ${nav.edges.length} sidewalk edges, grid ${surface.n}\n`,
    );

    // Umbra prism set over the whole padded area (caster reach 400 m = pad).
    const prisms = prismsFromFootprints(nav.buildings).prisms;

    // Canopy patch (cached) and the app's height field over it.
    const patch = await canopyPatchFor(block, surface);
    const canopyField = createCanopyHeightField(patch);

    // The field as routing uses it: static building prisms + raster canopy.
    // Provider coverage spans the truth surface (±675 m) so the field's own
    // query padding (cell region + QUERY_PAD_M = ±529 m) always resolves.
    const cosLatC = Math.cos((surface.centre[1] * Math.PI) / 180);
    const coverage = {
      west: surface.centre[0] - surface.extM / (111320 * cosLatC) - 0.01,
      east: surface.centre[0] + surface.extM / (111320 * cosLatC) + 0.01,
      south: surface.centre[1] - surface.extM / 111320 - 0.0001,
      north: surface.centre[1] + surface.extM / 111320 + 0.0001,
    };
    // Footprint subtraction (A8c) clamps a straddling ring's scanline to the
    // patch edge, which erases an entire row when a ring crosses it. In the
    // app the canopy patch always exceeds the caster-reach selection, so a
    // straddling prism is rare; here the 675 m prism set extends past the
    // 675 m patch, so mask with only the prisms the patch fully contains —
    // the prisms the app's own 400 m caster reach would have selected.
    const [pWest, pSouth, pEast, pNorth] = patch.bbox;
    const insidePatch = prisms.filter((p) =>
      p.ring.every(([lng, lat]) => lng >= pWest && lng <= pEast && lat >= pSouth && lat <= pNorth)
    );
    const canopyFieldMasked = canopyField.masked(insidePatch);
    const prismProvider = staticPrismProvider({ prisms, maxHeightM: 1 }, coverage, "nyc-static");
    // The field hands the raster to maskedRaster() itself, which re-masks with
    // the provider prisms — the straddle guard above applies to that set, so
    // hand it the already-masked field over a *contained* prism list: the
    // field's own mask call receives the same filtered set and is idempotent.
    const rasterProvider = {
      source: "canopy-raster",
      fieldFor(bbox) {
        return (
          bbox.west >= coverage.west && bbox.east <= coverage.east &&
          bbox.south >= coverage.south && bbox.north <= coverage.north
        ) ? canopyFieldMasked : null;
      },
      async load() {},
    };
    const field = createGeometryShadowField([prismProvider], [], [rasterProvider]);
    const fieldNoCanopy = createGeometryShadowField([prismProvider]);

    // Sidewalk sample points per edge, exactly the field's walk():
    const edges = nav.edges.map((e) => ({ ...e, from: e.from, to: e.to }));
    const instants = [];
    for (const g of GRID) {
      const sun = SunCalc.getPosition(g.when, surface.centre[1], surface.centre[0]);
      const mPerLat = 111320;
      const cosLat = Math.cos((surface.centre[1] * Math.PI) / 180);
      const mPerLng = 111320 * cosLat;
      const prepared = sun.altitude > 0 ? prepareShadowCasters(prisms) : null;
      const index =
        prepared && sun.altitude > 0
          ? buildShadowIndexFor(prepared, sun.azimuth, sun.altitude, mPerLat, mPerLng, {
              west: coverage.west,
              south: coverage.south,
              east: coverage.east,
              north: coverage.north,
            })
          : null;
      const rasterShade =
        canopyField && sun.altitude > 0 ? canopyField.shadeFor(sun.azimuth, sun.altitude, g.when) : null;

      // --- Mask comparison over the central 250×250 m ---
      const c0 = Math.floor((surface.extM - 125) / surface.cellM);
      const c1 = Math.ceil((surface.extM + 125) / surface.cellM);
      let tp = 0, fp = 0, fn = 0, tn = 0;
      let fnCanopy = 0, fnBuilding = 0, fnOther = 0;
      let excluded = 0;
      for (let r = c0; r < c1; r++) {
        for (let c = c0; c < c1; c++) {
          const eastM = (c + 0.5) * surface.cellM - surface.extM;
          const northM = surface.extM - (r + 0.5) * surface.cellM;
          const idx = r * surface.n + c;
          const receiverTop = surface.top[idx];
          const receiverGround = surface.ground[idx];
          // Exclude cells the receiver cannot stand on: roofs and crowns.
          if (Number.isFinite(receiverTop) && receiverTop - receiverGround > 2) { excluded++; continue; }
          const truth = truthAt(surface, landcover, centre, eastM, northM, sun.azimuth, sun.altitude);
          const lng = surface.centre[0] + eastM / mPerLng;
          const lat = surface.centre[1] + northM / mPerLat;
          const umbra = index ? (index.isShadowed(lng, lat) ? 1 : 0) : sun.altitude <= 0 ? 1 : 0;
          if (truth.shadow === 1 && umbra === 1) tp++;
          else if (truth.shadow === 1 && umbra === 0) {
            fn++;
            if (truth.blocker === "canopy") fnCanopy++;
            else if (truth.blocker === "building") fnBuilding++;
            else fnOther++;
          } else if (truth.shadow === 0 && umbra === 1) fp++;
          else tn++;
        }
      }
      const iou = (tp + fp + fn) > 0 ? tp / (tp + fp + fn) : null;

      // --- Sidewalk segment comparison ---
      const segments = [];
      for (const edge of edges) {
        const offsets = sidewalkOffsets(edge);
        const steps = edgeSampleCount(edge.distanceM);
        const side = (offset) => {
          let shadowAll = 0, shadowBldg = 0, canopyPts = 0, n2 = 0;
          const mPerLatE = 111320;
          const cos = Math.cos((((edge.from[1] + edge.to[1]) / 2) * Math.PI) / 180);
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const lng = edge.from[0] + t * (edge.to[0] - edge.from[0]) + offset[0];
            const lat = edge.from[1] + t * (edge.to[1] - edge.from[1]) + offset[1];
            const eastM = (lng - surface.centre[0]) * mPerLng;
            const northM = (lat - surface.centre[1]) * mPerLatE;
            if (Math.abs(eastM) >= surface.extM || Math.abs(northM) >= surface.extM) continue;
            const truth = truthAt(surface, landcover, centre, eastM, northM, sun.azimuth, sun.altitude);
            shadowAll += truth.shadow;
            // Trees removed: canopy-first rays march on to whatever stands behind.
            shadowBldg += truth.blocker === "canopy"
              ? truthAt(surface, landcover, centre, eastM, northM, sun.azimuth, sun.altitude, true).shadow
              : truth.shadow;
            if (truth.blocker === "canopy") canopyPts++;
            n2++;
          }
          return {
            fraction: n2 ? shadowAll / n2 : null,
            buildingFraction: n2 ? shadowBldg / n2 : null,
            canopyPts,
            samples: n2,
          };
        };
        segments.push({
          id: edge.id,
          highway: edge.highway,
          distanceM: edge.distanceM,
          left: side(offsets.left),
          right: side(offsets.right),
        });
      }

      // Field answers for the same edges, with and without canopy.
      const withCanopy = field.sampleEdges(edges, g.when);
      const withoutCanopy = fieldNoCanopy.sampleEdges(edges, g.when);

      instants.push({
        label: g.label,
        hour: g.hour,
        iso: g.when.toISOString(),
        sunAltitudeDeg: (sun.altitude * 180) / Math.PI,
        sunAzimuthDeg: (sun.azimuth * 180) / Math.PI,
        mask: { tp, fp, fn, tn, excluded, iou, fnCanopy, fnBuilding, fnOther },
        segments,
        fieldWithCanopy: withCanopy.map((s) => ({
          left: s.left,
          right: s.right,
          source: s.source,
          confidence: s.confidence,
        })),
        fieldWithoutCanopy: withoutCanopy.map((s) => ({ left: s.left, right: s.right })),
      });
      process.stderr.write(`  ${g.label} ${g.hour}h: IoU ${iou === null ? "n/a" : iou.toFixed(3)} fnCanopy ${fnCanopy}\n`);
    }

    writeFileSync(outPath, `${JSON.stringify({ block, instants })}\n`);
    process.stderr.write(`results: ${block.slug} written\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
