/** Extends the offline benchmark with A3's production geometry and face policy. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createShadeSpotsView,
  shadeSpotGeometry,
  type ShadeSpotsQuery,
} from "../../../app/lib/navigationData/shadeSpots";
import { createSignatureView } from "../../../app/lib/navigationData/signatureView";
import { annualSquaredDistance } from "../../../app/lib/navigationData/shadeSimilaritySource";
import {
  selectNavigationShardsForBoxes,
  zoneAround,
} from "../../../app/lib/navigationData/remoteNavigation";
import type {
  NavigationManifest,
  NavigationStreetShard,
  NavigationShadeShard,
  NavigationSignatureIndex,
} from "../../../app/lib/navigationData/shardContract";
import type { ProfileCellIndex } from "../../../app/lib/navigationData/profileContract";
const [root, previous, output, limitArg, radiusArg] = process.argv.slice(2);
if (!root || !previous || !output)
  throw new Error(
    "Pass generation directory, previous benchmark cache, output JSON, optional query limit",
  );
const manifest: NavigationManifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
const signatures: NavigationSignatureIndex = JSON.parse(
  await readFile(join(root, "signatures/index.json"), "utf8"),
);
const inventory: { cells: { key: string; start: number; end: number }[] } = JSON.parse(
  await readFile(join(previous, "inventory.json"), "utf8"),
);
const queries: { row: number; cell: number }[] = JSON.parse(
  await readFile(join(previous, "queries.json"), "utf8"),
);
type Loaded = {
  street: NavigationStreetShard;
  shade: NavigationShadeShard;
  signature: Uint8Array;
  annual: Uint8Array;
  source: Uint8Array;
  profile: ProfileCellIndex;
};
const cache = new Map<string, Loaded>();
async function cell(key: string) {
  let data = cache.get(key);
  if (data) {
    cache.delete(key);
    cache.set(key, data);
    return data;
  }
  const [street, shade, signature, annual, source, profile] = await Promise.all([
    readFile(join(root, `streets/${key}.json`), "utf8"),
    readFile(join(root, `shades/${key}.json`), "utf8"),
    readFile(join(root, `signatures/${key}.bin`)),
    readFile(join(root, `profiles/${key}.bin`)),
    readFile(join(root, `shades/${key}.bin`)),
    readFile(join(root, `profiles/${key}.json`), "utf8"),
  ]);
  data = {
    street: JSON.parse(street),
    shade: JSON.parse(shade),
    signature,
    annual,
    source,
    profile: JSON.parse(profile),
  };
  cache.set(key, data);
  while (cache.size > 24) cache.delete(cache.keys().next().value!);
  return data;
}
const metrics: Record<string, Array<Record<string, number>>> = { "200": [], "400": [], "800": [] };
const started = performance.now();
const limit = Number(limitArg) || queries.length;
const radii = radiusArg ? [Number(radiusArg) as 200 | 400 | 800] : ([200, 400, 800] as const);
if (radii.some((r) => ![200, 400, 800].includes(r))) throw new Error("invalid benchmark radius");
const checkpointPath = output + ".checkpoint.json";
let completed = 0;
try {
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  if (
    checkpoint.generation !== manifest.generation ||
    checkpoint.limit !== limit ||
    JSON.stringify(checkpoint.radii) !== JSON.stringify(radii)
  )
    throw new Error("checkpoint configuration mismatch");
  completed = checkpoint.completed;
  Object.assign(metrics, checkpoint.metrics);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
for (const [position, q] of queries.slice(0, limit).entries()) {
  if (position < completed) continue;
  const ownerKey = inventory.cells[q.cell].key,
    owner = await cell(ownerKey);
  const local = q.row - inventory.cells[q.cell].start;
  const [lo, hi] = owner.shade.segments[Math.floor(local / 2)],
    key = `${lo},${hi}`,
    side = (local % 2) as 0 | 1;
  const a = owner.street.nodes.find((n) => n.id === lo)!,
    b = owner.street.nodes.find((n) => n.id === hi)!;
  if (!a || !b) throw new Error("reference geometry missing");
  const lat = (a.lat + b.lat) / 2,
    lng = (a.lon + b.lon) / 2;
  for (const radiusM of radii) {
    const selected = selectNavigationShardsForBoxes(
      manifest,
      { south: lat, north: lat, west: lng, east: lng },
      [zoneAround(lng, lat, radiusM)],
      0,
    );
    if (!selected) continue;
    const selectedKeys = [
      ...new Set([
        ...selected.shadeShards.map((s) => s.key.split("/")[1].replace(/\.json$/, "")),
        ownerKey,
      ]),
    ];
    const data = await Promise.all(selectedKeys.map(cell));
    const streetKeys = [
      ...new Set([
        ...selected.streets.map((s) => s.key.split("/")[1].replace(/\.json$/, "")),
        ...selectedKeys,
      ]),
    ];
    const streets = await Promise.all(streetKeys.map(async (k) => (await cell(k)).street));
    const query: ShadeSpotsQuery = {
      lat,
      lng,
      radiusM,
      date: "2026-06-15",
      fromMinutes: 840,
      toMinutes: 960,
      mode: "shade",
    };
    const view = createShadeSpotsView(
      streets,
      data.map((d) => ({ shard: d.shade, blocks: new Map() })),
    );
    const geometry = shadeSpotGeometry(view, query),
      anchor = geometry.find((s) => s.key === key && s.signatureSide === side);
    if (!anchor) continue;
    const pool = geometry.filter((s) => s.blockFaceId !== anchor.blockFaceId);
    if (!pool.length) continue;
    const rows = new Map<string, { data: Loaded; row: number }>();
    for (const d of data)
      for (const [i, [l, h]] of d.shade.segments.entries())
        for (const s of [0, 1]) rows.set(`${l},${h}/${s}`, { data: d, row: i * 2 + s });
    const id = (s: { key: string; signatureSide: number }) => `${s.key}/${s.signatureSide}`;
    const packed = (s: { key: string; signatureSide: number }) => {
      const r = rows.get(id(s))!;
      return r.data.annual.subarray(r.row * 581, (r.row + 1) * 581);
    };
    const reference = packed(anchor),
      qrow = rows.get(id(anchor))!;
    // Brute-force truth reads original slot-major bytes, independently of the pack decoder.
    const exact = (s: typeof anchor) => {
      const r = rows.get(id(s))!;
      let sum = 0;
      for (const slot of signatures.model.daySlots) {
        const delta =
          qrow.data.source[slot * qrow.data.shade.segments.length * 2 + qrow.row] -
          r.data.source[slot * r.data.shade.segments.length * 2 + r.row];
        sum += delta * delta;
      }
      return sum;
    };
    const compare = (
      a: { spot: typeof anchor; distance: number },
      b: { spot: typeof anchor; distance: number },
    ) =>
      a.distance - b.distance ||
      a.spot.distanceM - b.spot.distanceM ||
      a.spot.candidateId.localeCompare(b.spot.candidateId);
    const truth = pool.map((spot) => ({ spot, distance: exact(spot) })).sort(compare);
    const sig = createSignatureView(
      signatures,
      data.map((d) => ({ shard: d.shade, payload: d.signature })),
    );
    const neighbours = sig.nearest(key, side, 500, new Set(pool.map(id)))!;
    const geometryOf = new Map(pool.map((s) => [id(s), s]));
    const shortlist = neighbours
      .map((n) => ({
        spot: geometryOf.get(`${n.key}/${n.side}`)!,
        distance: annualSquaredDistance(reference, packed({ key: n.key, signatureSide: n.side })),
      }))
      .sort(compare);
    const top = (ranked: typeof truth, k: number) => {
      const seen = new Set<string>();
      return ranked
        .filter((r) => {
          if (seen.has(r.spot.blockFaceId)) return false;
          seen.add(r.spot.blockFaceId);
          return true;
        })
        .slice(0, k);
    };
    const trueFaces = top(truth, 4),
      predictedFaces = top(shortlist, 4),
      faceIds = new Set(predictedFaces.map((r) => r.spot.blockFaceId));
    const trueSides = truth.slice(0, 10),
      predictedIds = new Set(shortlist.slice(0, 10).map((r) => r.spot.candidateId));
    const pageSet = new Map<string, number>();
    for (const s of [anchor, ...shortlist.map((r) => r.spot)]) {
      const r = rows.get(id(s))!,
        page = Math.floor(r.row / 32),
        pkey = `${r.data.shade.payload.key}/${page}`;
      pageSet.set(pkey, Math.min(32, r.data.shade.segments.length * 2 - page * 32) * 581);
    }
    const pages = [...pageSet.keys()].sort((a, b) => {
      const [ac, ap] = a.split(".bin/"),
        [bc, bp] = b.split(".bin/");
      return ac.localeCompare(bc) || Number(ap) - Number(bp);
    });
    let requests = 0,
      lastCell = "",
      lastPage = -2,
      runLength = 0;
    for (const p of pages) {
      const [c, n] = p.split(".bin/");
      if (c !== lastCell || Number(n) !== lastPage + 1 || runLength === 14) {
        requests++;
        runLength = 0;
      }
      lastCell = c;
      lastPage = Number(n);
      runLength++;
    }
    metrics[String(radiusM)].push({
      query: q.row,
      pool: pool.length,
      k10: trueSides.length,
      sideRecall:
        trueSides.filter((r) => predictedIds.has(r.spot.candidateId)).length / trueSides.length,
      faceRecall:
        trueFaces.filter((r) => faceIds.has(r.spot.blockFaceId)).length / trueFaces.length,
      profileBytes: [...pageSet.values()].reduce((a, b) => a + b, 0),
      profileRequests: requests,
    });
  }
  if (position % 25 === 0 || position === limit - 1)
    await writeFile(
      checkpointPath,
      JSON.stringify({
        generation: manifest.generation,
        limit,
        radii,
        completed: position + 1,
        metrics,
      }),
    );
  if (position % 100 === 0)
    console.log(
      JSON.stringify({
        queries: position + 1,
        elapsedSeconds: Math.round((performance.now() - started) / 1000),
      }),
    );
}
const percentile = (values: number[], p: number) => {
  const a = [...values].sort((a, b) => a - b);
  return a[Math.floor((a.length - 1) * p)];
};
const report = {
  generation: manifest.generation,
  queries: limit,
  window: { date: "2026-06-15", fromMinutes: 840, toMinutes: 960 },
  shortlist: 500,
  elapsedSeconds: (performance.now() - started) / 1000,
  radii: Object.fromEntries(
    Object.entries(metrics)
      .filter(([, rows]) => rows.length)
      .map(([radius, rows]) => [
        radius,
        {
          queries: rows.length,
          skippedQueries: limit - rows.length,
          skippedQueryIds: queries
            .slice(0, limit)
            .filter((q) => !rows.some((r) => r.query === q.row))
            .map((q) => q.row),
          queriesWithTen: rows.filter((r) => r.k10 === 10).length,
          meanRecall10: rows.reduce((n, r) => n + r.sideRecall, 0) / rows.length,
          meanFaceRecall4: rows.reduce((n, r) => n + r.faceRecall, 0) / rows.length,
          sideFailures: rows.filter((r) => r.sideRecall < 0.95).length,
          faceFailures: rows.filter((r) => r.faceRecall < 0.95).length,
          profileBytes: {
            median: percentile(
              rows.map((r) => r.profileBytes),
              0.5,
            ),
            p95: percentile(
              rows.map((r) => r.profileBytes),
              0.95,
            ),
            max: Math.max(...rows.map((r) => r.profileBytes)),
          },
          profileRequests: {
            median: percentile(
              rows.map((r) => r.profileRequests),
              0.5,
            ),
            p95: percentile(
              rows.map((r) => r.profileRequests),
              0.95,
            ),
          },
          worst: rows
            .sort((a, b) => a.sideRecall - b.sideRecall || a.faceRecall - b.faceRecall)
            .slice(0, 5),
        },
      ]),
  ),
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
