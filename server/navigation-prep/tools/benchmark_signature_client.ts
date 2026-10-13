/**
 * A3 CPU/parity probe adapted from navigationScale.bench.ts and signatures.test.ts.
 * Uses the ACTUAL client SignatureView + ShadeTableView over verified published
 * bytes; no browser/network/GPU timing is claimed. Python supplies spatial cases
 * and its exact-byte reference so a divergent decoder/row order cannot pass.
 *
 * PATH=~/.local/node24/bin:$PATH node_modules/.bin/tsx tools/benchmark_signature_client.ts \
 *   <generation-directory> <python-results-directory>
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createSignatureView,
  type SignatureSide,
} from "../../../app/lib/navigationData/signatureView";
import { createShadeTableView } from "../../../app/lib/navigationData/shadeTable";
import { shadeSegmentKey } from "../../../app/lib/navigationData/shadeSlots";
import {
  parseNavigationSignatureIndex,
  type NavigationManifest,
  type NavigationShadeShard,
} from "../../../app/lib/navigationData/shardContract";

type Cell = { key: string; start: number; end: number };
type Probe = {
  query: { row: number };
  radius: number;
  eligible_rows: number[];
  expected_shortlist: number[];
  exact_squared_bytes: number[];
};
const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("Pass generation directory and Python results directory");
const manifest: NavigationManifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
const indexBytes = await readFile(join(root, "signatures/index.json"));
assert.equal(createHash("sha256").update(indexBytes).digest("hex"), manifest.signatures!.sha256);
const index = parseNavigationSignatureIndex(
  JSON.parse(indexBytes.toString()),
  manifest.signatures!,
  manifest.generation,
);
const inventory = JSON.parse(await readFile(join(output, "inventory.json"), "utf8")) as {
  cells: Cell[];
};
const probes: Probe[] = JSON.parse(await readFile(join(output, "probes.json"), "utf8"));
const cache = new Map<
  string,
  { shard: NavigationShadeShard; signatures: Uint8Array; annual: Uint8Array }
>();
const timings: Record<string, number[]> = {};
const record = (label: string, duration: number) => {
  timings[label] ??= [];
  timings[label].push(duration);
};
let parityQueries = 0;
let parityNeighbours = 0;
for (const probe of probes) {
  const grouped = new Map<Cell, number[]>();
  for (const row of probe.eligible_rows) {
    const cell = inventory.cells.find((c) => c.start <= row && row < c.end)!;
    assert.ok(cell);
    if (!grouped.has(cell)) grouped.set(cell, []);
    if ((row - cell.start) % 2 === 0) grouped.get(cell)!.push((row - cell.start) / 2);
  }
  const ids = new Map<string, number>();
  const signatureCells = [];
  const shadeCells = [];
  const decodeStart = performance.now();
  for (const [cell, segments] of grouped) {
    let data = cache.get(cell.key);
    if (!data) {
      const ref = index.cells.find((c) => c.key === cell.key)!;
      const shard: NavigationShadeShard = JSON.parse(
        await readFile(join(root, ref.shadeKey), "utf8"),
      );
      const signatures = new Uint8Array(await readFile(join(root, ref.payloadKey)));
      const annual = new Uint8Array(await readFile(join(root, shard.payload.key)));
      assert.equal(createHash("sha256").update(signatures).digest("hex"), ref.sha256);
      assert.equal(createHash("sha256").update(annual).digest("hex"), shard.payload.sha256);
      data = { shard, signatures, annual };
      cache.set(cell.key, data);
    }
    const columns = segments.map((segment) => data!.shard.segments[segment]);
    const payload = new Uint8Array(segments.length * 2 * 17);
    for (const [i, segment] of segments.entries()) {
      payload.set(data.signatures.subarray(segment * 34, (segment + 1) * 34), i * 34);
      const key = shadeSegmentKey(...data.shard.segments[segment]);
      ids.set(`${key}/0`, cell.start + segment * 2);
      ids.set(`${key}/1`, cell.start + segment * 2 + 1);
    }
    signatureCells.push({ shard: { ...data.shard, segments: columns }, payload });
    const stride = data.shard.segments.length * 2;
    shadeCells.push({
      shard: data.shard,
      blocks: new Map(
        index.model.daySlots.map((slot) => [
          slot,
          data!.annual.subarray(slot * stride, (slot + 1) * stride),
        ]),
      ),
    });
  }
  record("prepare_ms_including_file_io", performance.now() - decodeStart);
  const buildStart = performance.now();
  const signatures = createSignatureView(index, signatureCells);
  const table = createShadeTableView(shadeCells);
  record("build_views_ms", performance.now() - buildStart);
  const queryCell = inventory.cells.find(
    (c) => c.start <= probe.query.row && probe.query.row < c.end,
  )!;
  const localQuery = probe.query.row - queryCell.start;
  const qkey = shadeSegmentKey(
    ...cache.get(queryCell.key)!.shard.segments[Math.floor(localQuery / 2)],
  );
  const qside = (localQuery % 2) as SignatureSide;
  const reference = index.model.daySlots.map((slot) => {
    const value = table.shadowFor(qkey, slot)!;
    return Math.round(value[qside === 0 ? "left" : "right"] * 255);
  });
  const exact = (key: string, side: SignatureSide): number => {
    let squared = 0;
    for (let i = 0; i < index.model.daySlots.length; i++) {
      const value = table.shadowFor(key, index.model.daySlots[i]);
      assert.ok(value, "missing published annual slot");
      const delta = reference[i] - Math.round(value[side === 0 ? "left" : "right"] * 255);
      squared += delta * delta;
    }
    return squared;
  };
  const initial = signatures.nearest(qkey, qside, 100)!;
  assert.deepEqual(
    initial.map((n) => ids.get(`${n.key}/${n.side}`)),
    probe.expected_shortlist,
    "Python/client PCA shortlist diverged",
  );
  assert.deepEqual(
    initial.map((n) => exact(n.key, n.side)),
    probe.exact_squared_bytes,
    "Python/client exact profile distance diverged",
  );
  parityQueries++;
  parityNeighbours += initial.length;
  for (const shortlist of [100, 200, 500]) {
    for (let repeat = 0; repeat < 11; repeat++) {
      const start = performance.now();
      const neighbours = signatures.nearest(qkey, qside, shortlist)!;
      const searchEnd = performance.now();
      const ranked = neighbours
        .map((n) => ({ ...n, distance: exact(n.key, n.side), id: ids.get(`${n.key}/${n.side}`)! }))
        .sort((a, b) => a.distance - b.distance || a.id - b.id)
        .slice(0, 10);
      assert.ok(ranked.every((n) => n.id !== probe.query.row));
      if (repeat) {
        record(`shortlist_${shortlist}_ms`, searchEnd - start);
        record(`rerank_${shortlist}_ms`, performance.now() - searchEnd);
      }
    }
  }
}
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
};
const report = {
  generation: manifest.generation,
  node: process.version,
  parity_queries: parityQueries,
  parity_neighbours: parityNeighbours,
  cache_cells: cache.size,
  timings: Object.fromEntries(
    Object.entries(timings).map(([label, values]) => [
      label,
      { median: percentile(values, 0.5), p95: percentile(values, 0.95), samples: values.length },
    ]),
  ),
};
await writeFile(join(output, "client-results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
