#!/usr/bin/env node
/**
 * S1 stage 5 — every number docs/notes/shade-accuracy.md quotes, re-derived
 * from cache/results/_summary.json and asserted to appear in the note.
 *
 * A check is [label, value, format]. Formatting is the note's own: pp to one
 * decimal, IoU to three, counts with thousands separators, deltas signed. A
 * failure names the label and the string it looked for, so a re-run that
 * moves a number points at the sentence to rewrite.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const s = JSON.parse(readFileSync(join(HERE, "cache", "results", "_summary.json"), "utf8"));
// Whitespace collapsed, so a phrase the note wraps across lines still matches.
const flat = (text) => text.replace(/\s+/g, " ");
const note = flat(readFileSync(join(HERE, "..", "..", "docs", "notes", "shade-accuracy.md"), "utf8"));

const pp = (v) => v.toFixed(1);
const signed = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
const iou = (v) => v.toFixed(3);
const count = (v) => v.toLocaleString("en-US");
const pct = (v) => `${Math.round(v * 100)}%`;
const mean = (x) => x.mean;

const checks = [];
const add = (label, text) => checks.push([label, text]);

// Headline table and bullets.
add("IoU mean", `**${iou(s.maskIoUPooled.mean)}**`);
add("IoU p50", iou(s.maskIoUPooled.p50));
add("IoU p90", iou(s.maskIoUPooled.p90));
add("IoU worst block-hour", iou(s.worstBlocks[0].minIoU));
add("err full", `**${pp(s.pooled.errAllPp.mean)}**`);
add("err buildings-only", `**${pp(s.pooled.errBuildingOnlyPp.mean)}**`);
add("err tree segs bldg-only", `**${pp(s.pooled.errCanopySegmentsPp.mean)}**`);
add("err tree segs full", `**${pp(s.pooled.errCanopySegmentsFullPp.mean)}**`);
add("err tree segs full p90", pp(s.pooled.errCanopySegmentsFullPp.p90));
add("canopy delta", `**${signed(s.pooled.canopyDeltaPp.mean)}**`);
add("canopy delta p90", signed(s.pooled.canopyDeltaPp.p90).replace(".0", ""));
add("fully wrong share", `**${pct(s.fullyWrongSides / s.pooled.errAllPp.n)} of segment-sides`);
add("fully wrong count", `(${count(s.fullyWrongSides)} of ${count(s.pooled.errAllPp.n)})`);
const miss = s.stalenessSplit.missCells;
const missTotal = miss.canopy + miss.building + miss.neither;
add("missed cells", count(missTotal));
add("false cells", count(s.stalenessSplit.falseShadeCells.all));
add("miss per false", (missTotal / s.stalenessSplit.falseShadeCells.all).toFixed(1));
add("miss shares", `tree canopy ${pct(miss.canopy / missTotal)}, building ${pct(miss.building / missTotal)}, neither ${pct(miss.neither / missTotal)}`);
add("June delta", `${signed(s.bySeason["jun-solstice"].meanCanopyDeltaPp)} pp at the June solstice`);
for (const [borough, name] of [["queens", "Queens"], ["bronx", "Bronx"], ["manhattan", "Manhattan"], ["brooklyn", "Brooklyn"]]) {
  add(`${name} delta bullet`, `${name} ${signed(s.byBorough[borough].meanCanopyDeltaPp)}`);
}
add("low-sun residual", `(${pp(s.byElevation["low(<20°)"].meanErrBuildingOnlyPp)} pp)`);

// Staleness section.
const excluded = Object.values(s.excludedBuildings).flat();
add("excluded count", `the ${count(excluded.length)} footprints`);
const vanderbilt = s.excludedBuildings["midtown-mn"].find((b) => b.id === "1284912");
add("One Vanderbilt Umbra", `${Math.round(vanderbilt.heightM)} m in`);
add("One Vanderbilt LiDAR", `${vanderbilt.lidarMedianM.toFixed(1)} m median`);
add("join rate", `${pct(Math.min(...Object.values(s.joinRates).map((j) => j.rate)))} of shard buildings matched`);
const fpDrop = s.stalenessSplit.falseShadeCells.all - s.stalenessSplit.falseShadeCells.era2017;
add("false shade removed", `${count(fpDrop)} of the ${count(s.stalenessSplit.falseShadeCells.all)}`);
add("false shade share", `about ${pct(fpDrop / s.stalenessSplit.falseShadeCells.all)}`);
const cx = s.stalenessSplit.perBlock["concourse-bx"];
add("Concourse fp drop", count(cx.fp - cx.fp2017));
add("err (a)->(b)", `${pp(s.pooled.errAllPp.mean)} to ${pp(s.pooled2017.errAllPp.mean)} pp`);
add("residual (a)->(b)", `${pp(s.pooled.errBuildingOnlyPp.mean)} to ${pp(s.pooled2017.errBuildingOnlyPp.mean)} pp`);
add("IoU (a)->(b)", `${iou(s.maskIoUPooled.mean)} to ${iou(s.maskIoUPooled2017.mean)}`);
const ev = s.excludedVsLidar;
add("proxy measured", `of the ${ev.measured} excluded footprints`);
add("proxy standing", `${ev.standingIn2017} were already standing`);
add("proxy absent", `and ${ev.absentIn2017} were absent`);
const demo = s.demolitionBoundTotal;
add("demolition tall", `${count(demo.tallBuildingM2)} m²`);
add("demolition uncovered", `${count(demo.uncoveredM2)} m² (${pct(demo.uncoveredM2 / demo.tallBuildingM2)})`);
const ch = s.changedCanopyExclusion;
add("changed sides", `${count(ch.changedSides)} of ${count(ch.sides)} sides (${pct(ch.changedShare)})`);
add("changed bldg-only", `${pp(s.pooled.errCanopySegmentsPp.mean)} to ${pp(ch.kept.errCanopySegmentsPp.mean)} pp buildings-only`);
add("changed full", `${pp(s.pooled.errCanopySegmentsFullPp.mean)} to ${pp(ch.kept.errCanopySegmentsFullPp.mean)} pp with canopy`);
add("changed delta", `${signed(s.pooled.canopyDeltaPp.mean)} to ${signed(ch.kept.canopyDeltaPp.mean)} pp`);
const sd = s.seasonDelta;
add("May/Jun bldg-only", `${pp(sd.may.errCanopySegmentsPp.mean)} vs ${pp(sd.june.errCanopySegmentsPp.mean)} pp buildings-only`);
add("May/Jun full", `${pp(sd.may.errCanopySegmentsFullPp.mean)} vs ${pp(sd.june.errCanopySegmentsFullPp.mean)} pp with canopy`);
add("May/Jun delta", `${signed(sd.may.canopyDeltaPp.mean)} vs ${signed(sd.june.canopyDeltaPp.mean)} pp canopy delta`);
const seasonGap = Math.max(
  ...["errCanopySegmentsPp", "errCanopySegmentsFullPp", "canopyDeltaPp"].map((k) => Math.abs(sd.may[k].mean - sd.june[k].mean)),
);
add("May/Jun max gap", `agree within ${pp(Math.ceil(seasonGap * 10) / 10)} pp`);
for (const [slug, date] of Object.entries(s.chmv2Dates)) add(`CHMv2 date ${slug}`, date.latest);

// Distribution tables.
const row = (label, cells) => add(label, `| ${cells.join(" | ")} |`);
const seasons = ["jun-solstice", "mar-equinox", "dec-solstice"].map((k) => s.bySeason[k]);
row("season IoU", ["IoU", ...seasons.map((v) => iou(v.meanIoU))]);
row("season full", ["error, full field", ...seasons.map((v) => pp(v.meanErrAllPp))]);
row("season bldg", ["error, buildings-only vs trees-removed truth", ...seasons.map((v) => pp(v.meanErrBuildingOnlyPp))]);
row("season tree", ["error on tree-shaded segments, buildings-only", ...seasons.map((v) => pp(v.meanErrCanopySegmentsPp))]);
row("season delta", ["canopy delta from CHMv2", ...seasons.map((v) => signed(v.meanCanopyDeltaPp))]);
for (const [key, label] of [["low(<20°)", "low (<20°)"], ["mid(20-40°)", "mid (20–40°)"], ["high(≥40°)", "high (≥40°)"]]) {
  const v = s.byElevation[key];
  row(`elevation ${key}`, [label, iou(v.meanIoU), pp(v.meanErrAllPp), pp(v.meanErrBuildingOnlyPp), pp(v.meanErrCanopySegmentsPp), signed(v.meanCanopyDeltaPp)]);
}
const hours = ["8", "10", "12", "14", "16"].map((h) => s.byHour[h]);
row("hour IoU", ["IoU", ...hours.map((v) => iou(v.meanIoU))]);
row("hour full", ["error, full field", ...hours.map((v) => pp(v.meanErrAllPp))]);
for (const [key, label] of [["manhattan", "Manhattan"], ["queens", "Queens"], ["brooklyn", "Brooklyn"], ["bronx", "Bronx"]]) {
  const v = s.byBorough[key];
  row(`borough ${key}`, [label, iou(v.meanIoU), pp(v.meanErrAllPp), pp(v.meanErrBuildingOnlyPp), signed(v.meanCanopyDeltaPp)]);
}
const names = {
  "williamsburg-bk": "Williamsburg", "greenpoint-bk": "Greenpoint", "harlem-mn": "Harlem", "village-mn": "Village",
  "astoria-qn": "Astoria", "concourse-bx": "Concourse", "jackson-hts-qn": "Jackson Heights", "midtown-mn": "Midtown",
};
for (const w of s.worstBlocks) {
  const hrs = s.perBlock[w.slug].hours;
  const tot = (k) => hrs.reduce((t, h) => t + h[k], 0);
  const m = tot("fnCanopy") + tot("fnBuilding") + tot("fnOther");
  const share = (k) => (tot(k) / m).toFixed(2);
  row(`block ${w.slug}`, [
    names[w.slug],
    iou(w.minIoU),
    pp(w.meanErrAllPp),
    `${share("fnCanopy")} / ${share("fnBuilding")} / ${share("fnOther")}`,
    (tot("fp") / m).toFixed(2),
    String(s.stalenessSplit.perBlock[w.slug].excludedBuildings),
  ]);
}

// Worst-blocks prose.
const wb = s.stalenessSplit.perBlock["williamsburg-bk"];
add("Williamsburg (b) err", `error at ${pp(wb.meanErrAll2017Pp)} pp`);
add("Williamsburg (b) IoU", `${iou(wb.meanIoU2017)} against ${iou(wb.meanIoU)}`);
add("Concourse fp", `${count(cx.fp - cx.fp2017)} of its ${count(cx.fp)}`);
add("Concourse err", `${pp(cx.meanErrAllPp)} to ${pp(cx.meanErrAll2017Pp)} pp`);
const mt = s.stalenessSplit.perBlock["midtown-mn"];
add("Midtown >100m", `${mt.excludedOver100m} of its ${mt.excludedBuildings} excluded`);
add("Midtown fp", `${count(mt.fp - mt.fp2017)} of ${count(mt.fp)}`);
add("Midtown err", `${pp(mt.meanErrAllPp)} to ${pp(mt.meanErrAll2017Pp)} pp`);
const blockDeltas = ["greenpoint-bk", "harlem-mn", "village-mn", "astoria-qn"].map((slug) => {
  const hrs = s.perBlock[slug].hours.filter((h) => h.canopyDeltaPp);
  const n = hrs.reduce((t, h) => t + h.canopyDeltaPp.n, 0);
  return hrs.reduce((t, h) => t + h.canopyDeltaPp.mean * h.canopyDeltaPp.n, 0) / n;
});
add("four-block delta range", `${signed(Math.min(...blockDeltas))} to ${signed(Math.max(...blockDeltas))} pp`);

let failed = 0;
for (const [label, text] of checks) {
  if (!note.includes(flat(text))) {
    failed++;
    process.stdout.write(`MISSING  ${label}: ${JSON.stringify(text)}\n`);
  }
}
process.stdout.write(`${checks.length - failed}/${checks.length} note values match _summary.json\n`);
process.exit(failed ? 1 : 0);
