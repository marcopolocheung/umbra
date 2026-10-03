#!/usr/bin/env node
/**
 * S1 stage 4 — fold cache/results/*.json into the distributions the note
 * reports: mask IoU and per-segment shade-fraction error, split by
 * building-only vs canopy, hour, solar elevation, and borough; name the worst
 * blocks; and compute the canopy delta (field with canopy − field without).
 *
 * Segment error is |Umbra − truth| on the shade fraction of one sidewalk side
 * of one edge, in percentage points. "Building-only" truth is the same march
 * with the trees removed (30-eval's `skipCanopy`): a ray that meets a street
 * tree marches on to whatever stands behind it. So the buildings-only field is
 * graded against everything except trees — wrong heights, missing footprints,
 * alignment, and casters no footprint holds (viaducts, sheds). Canopy-bearing
 * segments carry truth tree shade; their buildings-only error is the tree
 * shade the model cannot see.
 *
 * Staleness (the PR #219 correction pass). The truth is a 2017 flight; Umbra's
 * buildings are 2026 footprints and its canopy a 2018–2020 mosaic. So:
 * - every error is reported twice — (a) all buildings, as shipped, and (b) the
 *   2017-era set (CONSTRUCTION_YEAR ≤ 2017 or unknown). (a) − (b) is the share
 *   new buildings cause; (b) is the cleaner model error;
 * - canopy errors are re-reported with every sidewalk side dropped whose truth
 *   rays crossed 2017→2021 canopy gain or loss (`changedPts > 0`);
 * - the May 10 instants (the flight date) are kept out of every pooled and
 *   per-season figure and reported only as the May-vs-June delta.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "cache", "results");

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    worst: sorted[sorted.length - 1],
  };
}

/** The flight-date instants: reported only as the May-vs-June delta. */
const MAY = "may-flight";

/**
 * Per-side errors for one instant against one field pair. `dropChanged` skips
 * sides whose truth rays crossed 2017→2021 canopy change. `canopyFull` is the
 * full field's error on tree-shaded sides — the one canopy error the raster
 * can move.
 */
function instantErrors(instant, withKey, withoutKey, dropChanged = false) {
  const out = { all: [], buildingOnly: [], canopySegments: [], canopyFull: [], canopyDelta: [], changedSides: 0 };
  for (let i = 0; i < instant.segments.length; i++) {
    const seg = instant.segments[i];
    const field = instant[withKey][i];
    const fieldNo = instant[withoutKey][i];
    if (!field || !fieldNo) continue;
    for (const side of ["left", "right"]) {
      const truth = seg[side];
      if (truth.fraction === null || truth.samples === 0) continue;
      if (truth.changedPts > 0) {
        out.changedSides++;
        if (dropChanged) continue;
      }
      out.all.push(Math.abs(field[side] - truth.fraction) * 100);
      out.buildingOnly.push(Math.abs(fieldNo[side] - truth.buildingFraction) * 100);
      if (truth.canopyPts > 0) {
        out.canopySegments.push(Math.abs(fieldNo[side] - truth.fraction) * 100);
        out.canopyFull.push(Math.abs(field[side] - truth.fraction) * 100);
        out.canopyDelta.push((field[side] - fieldNo[side]) * 100);
      }
    }
  }
  return out;
}

const KINDS = ["all", "buildingOnly", "canopySegments", "canopyFull", "canopyDelta"];
const emptyPool = () => Object.fromEntries(KINDS.map((k) => [k, []]));
const pushPool = (pool, errs) => {
  for (const k of KINDS) for (const v of errs[k]) pool[k].push(v);
};
const statsPool = (pool) => ({
  errAllPp: stats(pool.all),
  errBuildingOnlyPp: stats(pool.buildingOnly),
  errCanopySegmentsPp: stats(pool.canopySegments),
  errCanopySegmentsFullPp: stats(pool.canopyFull),
  canopyDeltaPp: stats(pool.canopyDelta),
});

function main() {
  const rows = [];
  const pooled = emptyPool();
  const pooled2017 = emptyPool();
  const pooledUnchanged = emptyPool();
  const pooled2017Unchanged = emptyPool();
  const sides = { total: 0, changed: 0 };
  const season = { "jun-solstice": emptyPool(), [MAY]: emptyPool() };
  const blockMeta = {};
  for (const file of readdirSync(RESULTS).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()) {
    const { block, meta, instants } = JSON.parse(readFileSync(join(RESULTS, file), "utf8"));
    blockMeta[block.slug] = { borough: block.borough, ...meta };
    for (const instant of instants) {
      const a = instantErrors(instant, "fieldWithCanopy", "fieldWithoutCanopy");
      if (season[instant.label]) pushPool(season[instant.label], a);
      if (instant.label === MAY) continue;
      const b = instantErrors(instant, "fieldWithCanopy2017", "fieldWithoutCanopy2017");
      pushPool(pooled, a);
      pushPool(pooled2017, b);
      pushPool(pooledUnchanged, instantErrors(instant, "fieldWithCanopy", "fieldWithoutCanopy", true));
      pushPool(pooled2017Unchanged, instantErrors(instant, "fieldWithCanopy2017", "fieldWithoutCanopy2017", true));
      sides.total += a.all.length;
      sides.changed += a.changedSides;
      const canopySegments = instant.segments.filter(
        (s) => s.left.canopyPts + s.right.canopyPts > 0,
      ).length;
      rows.push({
        block: block.slug,
        borough: block.borough,
        label: instant.label,
        hour: instant.hour,
        sunAltitudeDeg: instant.sunAltitudeDeg,
        iou: instant.mask.iou,
        iou2017: instant.mask2017.iou,
        fnCanopy: instant.mask.fnCanopy,
        fnBuilding: instant.mask.fnBuilding,
        fnOther: instant.mask.fnOther,
        fp: instant.mask.fp,
        fp2017: instant.mask2017.fp,
        fnBuilding2017: instant.mask2017.fnBuilding,
        errAll: stats(a.all),
        errBuildingOnly: stats(a.buildingOnly),
        errCanopySegments: stats(a.canopySegments),
        canopyDeltaPp: stats(a.canopyDelta),
        errAll2017: stats(b.all),
        errBuildingOnly2017: stats(b.buildingOnly),
        canopySegments,
        sidewalkSegments: instant.segments.length,
      });
    }
  }

  const by = (keyFn, valueFn) => {
    const groups = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (key === null || key === undefined) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const out = {};
    for (const [key, group] of groups) {
      const ious = group.map((r) => r.iou).filter((v) => v !== null);
      const ious2017 = group.map((r) => r.iou2017).filter((v) => v !== null);
      out[key] = {
        hours: group.length,
        meanIoU: ious.length ? ious.reduce((s, v) => s + v, 0) / ious.length : null,
        minIoU: ious.length ? Math.min(...ious) : null,
        meanIoU2017: ious2017.length ? ious2017.reduce((s, v) => s + v, 0) / ious2017.length : null,
        meanErrAllPp: meanOf(group, "errAll"),
        meanErrBuildingOnlyPp: meanOf(group, "errBuildingOnly"),
        meanErrCanopySegmentsPp: meanOf(group, "errCanopySegments"),
        meanCanopyDeltaPp: meanOf(group, "canopyDeltaPp"),
        meanErrAll2017Pp: meanOf(group, "errAll2017"),
        meanErrBuildingOnly2017Pp: meanOf(group, "errBuildingOnly2017"),
      };
    }
    return out;
  };
  const meanOf = (group, field) => {
    let sum = 0;
    let n = 0;
    for (const row of group) {
      const s = row[field];
      if (!s) continue;
      sum += s.mean * s.n;
      n += s.n;
    }
    return n === 0 ? null : sum / n;
  };
  const elevationBand = (row) =>
    row.sunAltitudeDeg < 20 ? "low(<20°)" : row.sunAltitudeDeg < 40 ? "mid(20-40°)" : "high(≥40°)";

  const perBlock = {};
  for (const row of rows) {
    if (!perBlock[row.block]) perBlock[row.block] = [];
    perBlock[row.block].push(row);
  }
  const worstBlocks = Object.entries(perBlock)
    .map(([slug, hrs]) => ({
      slug,
      borough: hrs[0].borough,
      minIoU: Math.min(...hrs.map((h) => h.iou)),
      meanErrAllPp: meanOf(hrs, "errAll"),
      canopySegments: hrs.reduce((s, h) => s + h.canopySegments, 0),
    }))
    .sort((a, b) => a.minIoU - b.minIoU);

  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const pooledA = statsPool(pooled);
  const pooledB = statsPool(pooled2017);
  const shift = (from, to) => (from && to ? from.mean - to.mean : null);
  const summary = {
    pooled: pooledA,
    pooled2017: pooledB,
    // Sides the full field gets entirely wrong (all sun vs all shade, or back).
    fullyWrongSides: pooled.all.filter((v) => v >= 100 - 1e-9).length,
    maskIoUPooled: stats(rows.map((r) => r.iou).filter((v) => v !== null)),
    maskIoUPooled2017: stats(rows.map((r) => r.iou2017).filter((v) => v !== null)),
    // (a) − (b): the part of each error the post-2017 buildings cause.
    stalenessSplit: {
      errAllPp: shift(pooledA.errAllPp, pooledB.errAllPp),
      errBuildingOnlyPp: shift(pooledA.errBuildingOnlyPp, pooledB.errBuildingOnlyPp),
      falseShadeCells: { all: sum("fp"), era2017: sum("fp2017") },
      buildingMissCells: { all: sum("fnBuilding"), era2017: sum("fnBuilding2017") },
      missCells: { canopy: sum("fnCanopy"), building: sum("fnBuilding"), neither: sum("fnOther") },
      perBlock: Object.fromEntries(
        Object.entries(blockMeta).map(([slug, m]) => {
          const hrs = rows.filter((r) => r.block === slug);
          return [slug, {
            excludedBuildings: m.buildingSets.excluded.length,
            excludedOver100m: m.buildingSets.excluded.filter((b) => b.heightM > 100).length,
            meanIoU: hrs.reduce((s, r) => s + r.iou, 0) / hrs.length,
            meanIoU2017: hrs.reduce((s, r) => s + r.iou2017, 0) / hrs.length,
            meanErrAllPp: meanOf(hrs, "errAll"),
            meanErrAll2017Pp: meanOf(hrs, "errAll2017"),
            meanErrBuildingOnlyPp: meanOf(hrs, "errBuildingOnly"),
            meanErrBuildingOnly2017Pp: meanOf(hrs, "errBuildingOnly2017"),
            fp: hrs.reduce((s, r) => s + r.fp, 0),
            fp2017: hrs.reduce((s, r) => s + r.fp2017, 0),
          }];
        }),
      ),
    },
    // Sides whose truth rays crossed 2017→2021 canopy gain/loss, dropped.
    changedCanopyExclusion: {
      sides: sides.total,
      changedSides: sides.changed,
      changedShare: sides.total ? sides.changed / sides.total : null,
      kept: statsPool(pooledUnchanged),
      kept2017: statsPool(pooled2017Unchanged),
    },
    // May 10 (the flight date) vs June 21, same hours, set (a). The model's
    // leaf state is the same in both months (LEAF_ON_MONTHS_NORTH 4–10), and
    // the truth's is fixed at the flight, so this isolates sun position.
    seasonDelta: {
      may: statsPool(season[MAY]),
      june: statsPool(season["jun-solstice"]),
    },
    canopyMask: Object.fromEntries(Object.entries(blockMeta).map(([slug, m]) => [slug, m.canopy])),
    demolitionBound: Object.fromEntries(Object.entries(blockMeta).map(([slug, m]) => [slug, m.demolition])),
    joinRates: Object.fromEntries(
      Object.entries(blockMeta).map(([slug, m]) => [slug, {
        joined: m.buildingSets.joined,
        inEnvelope: m.buildingSets.shardBuildingsInEnvelope,
        rate: m.buildingSets.joined / m.buildingSets.shardBuildingsInEnvelope,
        unknownYear: m.buildingSets.unknownYear,
      }]),
    ),
    // How good CONSTRUCTION_YEAR > 2017 is as "absent from the 2017 truth":
    // standing = LiDAR median ≥ half the Umbra height and > 6 m; absent = < 3 m.
    excludedVsLidar: (() => {
      const all = Object.values(blockMeta).flatMap((m) => m.buildingSets.excluded);
      const measured = all.filter((b) => b.lidarMedianM !== null);
      return {
        excluded: all.length,
        measured: measured.length,
        standingIn2017: measured.filter((b) => b.lidarMedianM >= 0.5 * b.heightM && b.lidarMedianM > 6).length,
        absentIn2017: measured.filter((b) => b.lidarMedianM < 3).length,
      };
    })(),
    demolitionBoundTotal: Object.values(blockMeta).reduce(
      (t, m) => ({
        tallBuildingM2: t.tallBuildingM2 + m.demolition.tallBuildingM2,
        uncoveredM2: t.uncoveredM2 + m.demolition.uncoveredM2,
      }),
      { tallBuildingM2: 0, uncoveredM2: 0 },
    ),
    excludedBuildings: Object.fromEntries(
      Object.entries(blockMeta).map(([slug, m]) => [slug, m.buildingSets.excluded]),
    ),
    chmv2Dates: chmv2Dates(blockMeta),
    byHour: by((r) => r.hour),
    bySeason: by((r) => r.label),
    byBorough: by((r) => r.borough),
    byElevation: by((r) => elevationBand(r)),
    worstBlocks,
    perBlock: Object.fromEntries(
      Object.entries(perBlock).map(([slug, hrs]) => [
        slug,
        {
          borough: hrs[0].borough,
          hours: hrs.map((h) => ({
            label: h.label,
            hour: h.hour,
            sunAltitudeDeg: Math.round(h.sunAltitudeDeg * 10) / 10,
            iou: h.iou === null ? null : Math.round(h.iou * 1000) / 1000,
            fnCanopy: h.fnCanopy,
            fnBuilding: h.fnBuilding,
            fnOther: h.fnOther,
            fp: h.fp,
            errAllPp: round(h.errAll),
            errBuildingOnlyPp: round(h.errBuildingOnly),
            errCanopySegmentsPp: round(h.errCanopySegments),
            canopyDeltaPp: round(h.canopyDeltaPp),
            canopySegments: h.canopySegments,
            sidewalkSegments: h.sidewalkSegments,
          })),
        },
      ]),
    ),
  };
  writeFileSync(join(RESULTS, "_summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`summary written: ${rows.length} block-hours\n`);
}

/**
 * CHMv2's imagery date at each block centre, from the cached metadata
 * footprints: every footprint holding the point, latest last — the
 * latest-wins rule scripts/canopy-acq-index.mjs states, copied not shared
 * (studies/README.md). The mosaic does not say which image a pixel came from.
 */
function chmv2Dates(blockMeta) {
  const dir = join(HERE, "cache", "chmv2-metadata");
  const features = readdirSync(dir).flatMap((f) =>
    JSON.parse(readFileSync(join(dir, f), "utf8")).features.map((ft) => ({ quadkey: f.split(".")[0], ...ft })),
  );
  const { blocks } = JSON.parse(readFileSync(join(HERE, "blocks.json"), "utf8"));
  const inRing = (ring, x, y) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const polygons = (g) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
  const contains = (g, x, y) =>
    polygons(g).some(([outer, ...holes]) => inRing(outer, x, y) && !holes.some((h) => inRing(h, x, y)));
  const out = {};
  for (const b of blocks.filter((bl) => blockMeta[bl.slug])) {
    const dates = features
      .filter((f) => f.properties.acq_date && contains(f.geometry, b.lng, b.lat))
      .map((f) => f.properties.acq_date)
      .sort();
    out[b.slug] = { latest: dates.at(-1) ?? null, all: [...new Set(dates)] };
  }
  return out;
}

function round(s) {
  if (!s) return null;
  return {
    n: s.n,
    mean: Math.round(s.mean * 10) / 10,
    p50: Math.round(s.p50 * 10) / 10,
    p90: Math.round(s.p90 * 10) / 10,
    worst: Math.round(s.worst * 10) / 10,
  };
}

main();
