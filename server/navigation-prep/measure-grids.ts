/**
 * One-off development measurement (not part of the shipped CLI): compares the
 * built z13 and z14 generations over the retained borough samples, printing
 * the selected cell/byte counts that decide the grid in the decision record.
 * Run: NAVIGATION_PREP_ROOT=... tsx measure-grids.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BOROUGH_SAMPLES, CASTER_REACH_M } from "./src/boundary";
import type { NavigationManifest } from "../../app/lib/navigationData/shardContract";

interface GeoBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

function pad(b: GeoBox, m: number) {
  const midLat = ((b.south + b.north) / 2) * (Math.PI / 180);
  const dLat = m / 111_320;
  const dLon = m / (111_320 * Math.max(Math.cos(midLat), 0.2));
  return { south: b.south - dLat, west: b.west - dLon, north: b.north + dLat, east: b.east + dLon };
}
function inter(a: GeoBox, b: GeoBox) {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

const root = process.env.NAVIGATION_PREP_ROOT;
if (!root) throw new Error("NAVIGATION_PREP_ROOT required");
const summary: Record<string, unknown> = {};
const lines: string[] = [];
for (const generation of process.argv.slice(2)) {
  const manifestPath = join(
    root,
    "normalized",
    generation,
    "navigation",
    "nyc",
    generation,
    "manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as NavigationManifest;
  const z = manifest.streetShards[0]?.key.startsWith("streets/z13-") ? "z13" : "z14";
  const rows: Record<string, unknown>[] = [];
  for (const sample of BOROUGH_SAMPLES) {
    const padded = pad(sample.bbox, CASTER_REACH_M);
    const streets = manifest.streetShards.filter((ref) => inter(ref.geometryBounds, sample.bbox));
    const buildings = manifest.buildingShards.filter((ref) => inter(ref.geometryBounds, padded));
    const bytes = [...streets, ...buildings].reduce((sum, ref) => sum + ref.bytes, 0);
    rows.push({
      borough: sample.borough,
      z,
      streetShards: streets.length,
      buildingShards: buildings.length,
      bytes,
    });
    lines.push(
      `${z} ${sample.borough}: ${streets.length} street + ${buildings.length} building cells = ${(bytes / 1e6).toFixed(2)} MB`,
    );
  }
  summary[`${generation} (${z})`] = { rows };
}
console.log(lines.join("\n"));
console.log(JSON.stringify(summary, null, 2));
