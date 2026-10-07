/**
 * Independent audit of a built shade generation (#294, #300) — the gate a
 * generation must pass before `publish --execute`. NOT part of any suite: it
 * reads a multi-GB local generation, so it runs only by hand —
 *
 *   NAVIGATION_PREP_ROOT=… SHADE_AUDIT_GENERATION=nyc-… \
 *   npm --prefix server/navigation-prep run audit:shade -- shadeAudit
 *
 * (`SHADE_AUDIT_CELLS=a,b` limits it to some cells; `routeReplay` is the
 * second file, pricing two known routes from the table.)
 *
 * The table was written by the build's own frozen providers. This recomputes the
 * same edges through the providers the **app** runs in production instead:
 * `createNycStaticPrismProvider` over the published building shards (manifest
 * selection, digest-verified loader, caster reach, dedupe), the Overpass canopy
 * provider, and the raster canopy provider — fed local copies of the same frozen
 * inputs, through the app's own code. Shared with the build: only `ShadowField`
 * itself (the thing the table is supposed to reproduce) and the OSM snapshot
 * parser. The instants are the table's own slot instants, so slot rounding is
 * excluded and any disagreement is a data or slicing difference.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGeometryShadowField, type EdgeRef } from "../../../app/lib/shadowField/ShadowField";
import {
  createOverpassCanopyProvider,
  createRasterCanopyProvider,
} from "../../../app/lib/shadowField/providers";
import { createNycStaticPrismProvider } from "../../../app/lib/navigationData/buildingProvider";
import { createCanopyTileStore } from "../../../app/lib/canopyRaster/canopyTileStore";
import { createCogTileSource } from "../../../app/lib/canopyRaster/cogTileSource";
import { buildRoutingGraphFromStreetShards } from "../../../app/lib/navigationData/routingGraphAdapter";
import { routingEdgeBatch } from "../../../app/lib/navigationHelpers";
import { acquireNavigationSnapshot } from "../../../app/lib/navigationData/remoteNavigation";
import {
  parseNavigationShadeShard,
  parseNavigationStreetShard,
} from "../../../app/lib/navigationData/shardContract";
import { shadeByteToFraction, SHADE_DAY_SLOTS } from "../../../app/lib/navigationData/shadeSlots";
import { defaultCanopyInputs, parseOsmVegetation, shadeSlotInstants } from "../src/shade";
import type { CanopyFeature } from "../../../app/lib/overpass";

const BASE = "https://audit.local";
const root = process.env.NAVIGATION_PREP_ROOT!;
const generation = process.env.SHADE_AUDIT_GENERATION!;
const cellFilter = process.env.SHADE_AUDIT_CELLS?.split(",");
const dir = join(root, "normalized", generation, "navigation", "nyc", generation);

/** Month-0 index × slot-in-day: Jan/Apr/Jul/Oct at 08:00, 12:00, 16:00. */
const SLOTS = [0, 3, 6, 9].flatMap((m) => [12, 28, 44].map((s) => m * SHADE_DAY_SLOTS + s));
const EDGES_PER_CELL = 150;

/** Serves the generation as the app's base would: `current.json` is the build's pointer candidate. */
async function localFetch(url: string | URL | Request): Promise<Response> {
  const href = String(url);
  if (href === `${BASE}/navigation/nyc/current.json`)
    return new Response(await readFile(join(root, "normalized", generation, "pointer-candidate.json")));
  return new Response(await readFile(join(dir, href.replace(`${BASE}/navigation/nyc/${generation}/`, ""))));
}

function radiusQuery(features: CanopyFeature[]) {
  return async (lng: number, lat: number, radiusM: number) => {
    const dLat = radiusM / 111320;
    const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
    return features.filter((f) =>
      f.points.some(([x, y]) => Math.abs(x - lng) <= dLng && Math.abs(y - lat) <= dLat),
    );
  };
}

describe("shade audit", () => {
  it("table agrees with the app's own providers", { timeout: 24 * 3600_000 }, async () => {
    vi.stubEnv("VITE_NAVIGATION_BASE", BASE);
    vi.stubGlobal("fetch", localFetch);
    // Acquired, not hand-built: the shard loaders serve only from the
    // generation cache this call creates.
    const snapshot = (await acquireNavigationSnapshot())!;
    expect(snapshot.generation).toBe(generation);
    const manifest = snapshot.manifest;
    const canopyInputs = defaultCanopyInputs();
    const osm = parseOsmVegetation(JSON.parse(await readFile(canopyInputs.osmVegetationPath, "utf8")));
    const store = createCanopyTileStore({
      source: createCogTileSource({
        baseUrl: canopyInputs.chmv2Dir,
        openTiff: async (url) => (await import("geotiff")).fromFile(url),
      }),
    });
    const instants = shadeSlotInstants();

    const rows: Array<{ cell: string; n: number; mean: number; p90: number; worst: number; tableZero: number; liveZero: number; unresolved: number }> = [];
    const all: number[] = [];
    const refs = manifest.shadeShards ?? [];
    for (const ref of refs) {
      const cell = ref.key.replace(/^shades\/|\.json$/g, "");
      if (cellFilter && !cellFilter.includes(cell)) continue;
      const index = parseNavigationShadeShard(
        JSON.parse(await readFile(join(dir, ref.key), "utf8")), ref, generation,
      );
      const payload = await readFile(join(dir, ref.payloadKey));
      const column = new Map(index.segments.map(([lo, hi], i) => [`${lo},${hi}`, i]));

      // Edges as the client sees them: the published street shard, canonicalised.
      const streetRef = manifest.streetShards.find((s) => s.key === `streets/${cell}.json`)!;
      const street = parseNavigationStreetShard(
        JSON.parse(await readFile(join(dir, streetRef.key), "utf8")), streetRef, generation,
      );
      const batch = routingEdgeBatch(buildRoutingGraphFromStreetShards([street]));
      const picks: Array<{ edge: EdgeRef; col: number }> = [];
      const stride = Math.max(1, Math.floor(batch.keys.length / EDGES_PER_CELL));
      for (let i = 0; i < batch.keys.length && picks.length < EDGES_PER_CELL; i += stride) {
        const col = column.get(batch.keys[i]);
        if (col !== undefined) picks.push({ edge: batch.refs[i], col });
      }
      if (picks.length === 0) continue;

      // A fresh app field per cell, exactly as wired in useRouting (no tiles/Overpass buildings).
      const buildings = createNycStaticPrismProvider();
      buildings.bindSnapshot(snapshot);
      const field = createGeometryShadowField(
        [buildings],
        [createOverpassCanopyProvider({ fetchCanopy: radiusQuery(osm) })],
        [createRasterCanopyProvider({ store })],
        [],
      );
      const edges = picks.map((p) => p.edge);
      await field.readyEdges(edges, { deadlineAt: Date.now() + 600_000 });

      const errors: number[] = [];
      let tableZero = 0, liveZero = 0, unresolved = 0, n = 0;
      for (const slot of SLOTS) {
        const live = field.sampleEdges(edges, instants[slot]);
        const block = slot * index.segments.length * 2;
        for (let i = 0; i < picks.length; i++) {
          const sample = live[i];
          if (sample.source === "none" && sample.confidence === 0) unresolved++;
          for (const [side, off] of [["left", 0], ["right", 1]] as const) {
            const table = shadeByteToFraction(payload[block + picks[i].col * 2 + off]);
            const value = sample[side];
            errors.push(Math.abs(table - value));
            if (table === 0) tableZero++;
            if (value === 0) liveZero++;
            n++;
          }
        }
      }
      errors.sort((a, b) => a - b);
      all.push(...errors);
      rows.push({
        cell, n,
        mean: errors.reduce((s, e) => s + e, 0) / errors.length,
        p90: errors[Math.floor(0.9 * (errors.length - 1))],
        worst: errors[errors.length - 1],
        tableZero: tableZero / n, liveZero: liveZero / n, unresolved,
      });
      process.stderr.write(`${JSON.stringify(rows[rows.length - 1])}\n`);
    }

    all.sort((a, b) => a - b);
    const q = (p: number) => all[Math.floor(p * (all.length - 1))];
    const summary = {
      cells: rows.length, samples: all.length,
      mean: all.reduce((s, e) => s + e, 0) / all.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), worst: q(1),
      cellsMeanOver0_1: rows.filter((r) => r.mean > 0.1).map((r) => r.cell),
      cellsUnresolved: rows.filter((r) => r.unresolved > 0).map((r) => [r.cell, r.unresolved]),
      cellsTableZeroOverLive: rows.filter((r) => r.tableZero - r.liveZero > 0.2).map((r) => r.cell),
    };
    process.stderr.write(`SUMMARY ${JSON.stringify(summary)}\n`);
    // The publish gate. Measured on nyc-2026-09-18-393d4cd24a30 (the first
    // generation published after #294/#300): cell-mean p99 0.025, worst 0.059,
    // none unresolved. A zeroed or canopy-dropping table fails every line here.
    expect(rows.length).toBeGreaterThan(0);
    expect(summary.cellsUnresolved).toEqual([]);
    expect(rows.filter((r) => r.mean > 0.1).map((r) => r.cell)).toEqual([]);
    expect(rows.filter((r) => r.mean > 0.05).length).toBeLessThanOrEqual(Math.ceil(rows.length * 0.01));
  });
});
