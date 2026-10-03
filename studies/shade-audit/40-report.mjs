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

function main() {
  const rows = [];
  const pooled = {
    all: [],
    buildingOnly: [],
    canopySegments: [],
    canopyDelta: [],
  };
  for (const file of readdirSync(RESULTS).filter((f) => f.endsWith(".json")).sort()) {
    const { block, instants } = JSON.parse(readFileSync(join(RESULTS, file), "utf8"));
    let worst = { iou: Infinity, hour: null, label: null, fnCanopy: 0 };
    for (const instant of instants) {
      const errsAll = [];
      const errsBuilding = [];
      const errsCanopy = [];
      const deltas = [];
      const canopySegments = instant.segments.filter(
        (s) => s.left.canopyPts + s.right.canopyPts > 0,
      ).length;
      for (let i = 0; i < instant.segments.length; i++) {
        const seg = instant.segments[i];
        const field = instant.fieldWithCanopy[i];
        const fieldNo = instant.fieldWithoutCanopy[i];
        if (!field || !fieldNo) continue;
        for (const side of ["left", "right"]) {
          const truth = seg[side];
          if (truth.fraction === null || truth.samples === 0) continue;
          errsAll.push(Math.abs(field[side] - truth.fraction) * 100);
          errsBuilding.push(Math.abs(fieldNo[side] - truth.buildingFraction) * 100);
          if (truth.canopyPts > 0) {
            errsCanopy.push(Math.abs(fieldNo[side] - truth.fraction) * 100);
            deltas.push((field[side] - fieldNo[side]) * 100);
          }
        }
      }
      pooled.all.push(...errsAll);
      pooled.buildingOnly.push(...errsBuilding);
      pooled.canopySegments.push(...errsCanopy);
      pooled.canopyDelta.push(...deltas);
      if (instant.mask.iou < worst.iou) {
        worst = {
          iou: instant.mask.iou,
          hour: instant.hour,
          label: instant.label,
          fnCanopy: instant.mask.fnCanopy,
        };
      }
      rows.push({
        block: block.slug,
        borough: block.borough,
        label: instant.label,
        hour: instant.hour,
        sunAltitudeDeg: instant.sunAltitudeDeg,
        iou: instant.mask.iou,
        fnCanopy: instant.mask.fnCanopy,
        fnBuilding: instant.mask.fnBuilding,
        fnOther: instant.mask.fnOther,
        fp: instant.mask.fp,
        errAll: stats(errsAll),
        errBuildingOnly: stats(errsBuilding),
        errCanopySegments: stats(errsCanopy),
        canopyDeltaPp: stats(deltas),
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
      out[key] = {
        hours: group.length,
        meanIoU: ious.length ? ious.reduce((s, v) => s + v, 0) / ious.length : null,
        minIoU: ious.length ? Math.min(...ious) : null,
        meanErrAllPp: meanOf(group, "errAll"),
        meanErrBuildingOnlyPp: meanOf(group, "errBuildingOnly"),
        meanErrCanopySegmentsPp: meanOf(group, "errCanopySegments"),
        meanCanopyDeltaPp: meanOf(group, "canopyDeltaPp"),
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

  const summary = {
    pooled: {
      errAllPp: stats(pooled.all),
      errBuildingOnlyPp: stats(pooled.buildingOnly),
      errCanopySegmentsPp: stats(pooled.canopySegments),
      canopyDeltaPp: stats(pooled.canopyDelta),
    },
    maskIoUPooled: stats(rows.map((r) => r.iou).filter((v) => v !== null)),
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
