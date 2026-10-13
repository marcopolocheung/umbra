/**
 * A4 product baseline: does find_shade_spots beat "walk to the nearest sidewalk"?
 *
 * For seeded random (origin, month, window) queries inside published support, the
 * A1 core ranks every eligible side exactly as the tool does. Compare the tool's
 * top result with the nearest eligible side: shade gained, extra metres walked,
 * and shade gained per extra 100 m. Reads the local generation; no network, no LLM.
 *
 *   tsx tools/benchmark_shade_baseline.ts <generation-dir> <output.json> [queries=200] [seed=20261013]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createShadeSpotsView,
  prepareShadeSpotsWindow,
  shadeSpots,
  type ShadeSpotsQuery,
} from "../../../app/lib/navigationData/shadeSpots";
import {
  selectNavigationShardsForBoxes,
  zoneAround,
} from "../../../app/lib/navigationData/remoteNavigation";
import {
  shadeSlotByteLength,
  shadeSlotByteOffset,
} from "../../../app/lib/navigationData/shadeSlots";
import type {
  NavigationManifest,
  NavigationShadeShard,
  NavigationStreetShard,
} from "../../../app/lib/navigationData/shardContract";

export interface Ranked {
  candidateId: string;
  meanShade: number;
  distanceM: number;
}

/** One query's comparison; null when there is nothing to compare. */
export function compareToNearest(ranked: readonly Ranked[]) {
  if (!ranked.length) return null;
  const top = ranked[0];
  const nearest = ranked.reduce((a, b) =>
    b.distanceM < a.distanceM || (b.distanceM === a.distanceM && b.candidateId < a.candidateId)
      ? b
      : a,
  );
  const shadeGain = top.meanShade - nearest.meanShade;
  const extraM = top.distanceM - nearest.distanceM;
  return {
    toolIsNearest: top.candidateId === nearest.candidateId,
    shadeGain,
    extraM,
    // Undefined when the tool's pick is no farther: the gain cost nothing.
    gainPer100m: extraM > 0 ? (100 * shadeGain) / extraM : null,
    topShade: top.meanShade,
    nearestShade: nearest.meanShade,
  };
}

/** mulberry32: a tiny deterministic PRNG, so the query set is reproducible. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function main() {
  const [root, output, countArg, seedArg] = process.argv.slice(2);
  if (!root || !output) throw new Error("Pass generation directory and output JSON");
  const count = Number(countArg) || 200;
  const random = seeded(Number(seedArg) || 20261013);
  const manifest: NavigationManifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  );
  const cells = new Map<
    string,
    { street: NavigationStreetShard; shade: NavigationShadeShard; bin: Buffer }
  >();
  async function cell(shadeKey: string) {
    const key = shadeKey.replace(/^shades\//, "").replace(/\.json$/, "");
    let data = cells.get(key);
    if (!data) {
      const [street, shade, bin] = await Promise.all([
        readFile(join(root, `streets/${key}.json`), "utf8"),
        readFile(join(root, `shades/${key}.json`), "utf8"),
        readFile(join(root, `shades/${key}.bin`)),
      ]);
      data = { street: JSON.parse(street), shade: JSON.parse(shade), bin };
      cells.set(key, data);
      while (cells.size > 32) cells.delete(cells.keys().next().value!);
    }
    return data;
  }
  const support = manifest.supportBounds;
  const rows: Array<Record<string, unknown>> = [];
  let attempts = 0;
  while (rows.length < count && attempts < count * 20) {
    attempts++;
    const lat = support.south + random() * (support.north - support.south);
    const lng = support.west + random() * (support.east - support.west);
    const month = 1 + Math.floor(random() * 12);
    const start = 7 * 60 + 15 * Math.floor(random() * 40); // 7:00–16:45 starts
    const query: ShadeSpotsQuery = {
      lat,
      lng,
      date: `2026-${String(month).padStart(2, "0")}-15`,
      fromMinutes: start,
      toMinutes: start + 120,
      radiusM: 400,
      mode: "shade",
    };
    const prepared = prepareShadeSpotsWindow(query);
    if (!prepared.effectiveWindow) continue;
    const refs = selectNavigationShardsForBoxes(
      manifest,
      { south: lat, north: lat, west: lng, east: lng },
      [zoneAround(lng, lat, 400)],
      0,
    );
    if (!refs?.shadeShards.length) continue;
    const loaded = await Promise.all(refs.shadeShards.map((r) => cell(r.key)));
    const slots = prepared.slots.map((s) => s.slot);
    const view = createShadeSpotsView(
      loaded.map((d) => d.street),
      loaded.map((d) => {
        const segments = d.shade.segments.length;
        const length = shadeSlotByteLength(segments);
        return {
          shard: d.shade,
          blocks: new Map(
            slots.map((slot) => {
              const offset = shadeSlotByteOffset(slot, segments);
              return [slot, new Uint8Array(d.bin.subarray(offset, offset + length))] as const;
            }),
          ),
        };
      }),
    );
    // Every eligible side, ranked as the tool ranks; the tool returns the first.
    const ranked = shadeSpots(view, query, { all: true }).results;
    const result = compareToNearest(ranked);
    if (!result) continue;
    rows.push({
      lat,
      lng,
      date: query.date,
      fromMinutes: start,
      candidates: ranked.length,
      ...result,
    });
  }
  const num = (k: string) =>
    rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
  const summary = {
    generation: manifest.generation ?? null,
    queries: rows.length,
    attempts,
    toolIsNearestShare: rows.filter((r) => r.toolIsNearest).length / (rows.length || 1),
    shadeGain: { median: quantile(num("shadeGain"), 0.5), p90: quantile(num("shadeGain"), 0.9) },
    extraM: { median: quantile(num("extraM"), 0.5), p90: quantile(num("extraM"), 0.9) },
    gainPer100m: {
      median: quantile(num("gainPer100m"), 0.5),
      p90: quantile(num("gainPer100m"), 0.9),
    },
    topShade: { median: quantile(num("topShade"), 0.5) },
    nearestShade: { median: quantile(num("nearestShade"), 0.5) },
  };
  await writeFile(output, JSON.stringify({ summary, rows }, null, 1));
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
}

if (process.argv[1]?.endsWith("benchmark_shade_baseline.ts")) await main();
