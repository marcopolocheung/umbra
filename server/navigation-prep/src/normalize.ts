import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./canonical";
import { buildingsToNdjson, normalizeBuildings, readBuildingPages } from "./buildings";
import { buildStreetGraph, type StreetEdge, type StreetNode } from "./graph";
import { BUILDINGS_EXPECTED_COUNT, BUILDINGS_PAGE_SIZE, readReceipts } from "./acquire";
import { parseRoads } from "./pbf";
import { rootPath, sha256Hex } from "./util";
import { histogram, type Histogram } from "./stats";

/**
 * Turns verified raw inputs into the compact intermediates `build` reads:
 * `work/streets.json` and `work/buildings.ndjson`. Never downloads; fails when
 * raw bytes no longer match the receipts they were pinned with.
 */

export interface NormalizeResult {
  streetGraph: {
    ways: number;
    nodes: number;
    edges: number;
    highwayHistogram: Histogram;
    surfaceHistogram: Histogram;
    stats: Record<string, number>;
  };
  buildings: {
    accepted: number;
    rejected: { reason: string; count: number }[];
    byFeatureCode: Histogram;
    byPublishedStatus: Histogram;
    known: number;
    fallback: number;
    unknown: number;
    repairedRings: number;
    maxHeightM: number;
  };
  written: string[];
}

export async function normalize(only?: "streets" | "buildings"): Promise<NormalizeResult> {
  const work = rootPath("work");
  await mkdir(work, { recursive: true });
  const written: string[] = [];

  let streetGraph: Awaited<ReturnType<typeof normalizeStreets>> | undefined;
  let buildings: Awaited<ReturnType<typeof normalizeBuildingsFromRaw>> | undefined;

  if (only !== "buildings") {
    streetGraph = await normalizeStreets();
    const path = join(work, "streets.json");
    await writeFile(path, `${canonicalJson(streetGraph.document)}\n`);
    written.push(path);
  }
  if (only !== "streets") {
    buildings = await normalizeBuildingsFromRaw();
    const path = join(work, "buildings.ndjson");
    await writeFile(path, buildingsToNdjson(buildings.result.buildings));
    written.push(path);
  }

  const emptyStreets = {
    ways: 0,
    nodes: 0,
    edges: 0,
    highwayHistogram: {} as Histogram,
    surfaceHistogram: {} as Histogram,
    stats: {} as Record<string, number>,
  };
  const emptyBuildings = {
    accepted: 0,
    rejected: [] as { reason: string; count: number }[],
    byFeatureCode: {} as Histogram,
    byPublishedStatus: {} as Histogram,
    known: 0,
    fallback: 0,
    unknown: 0,
    repairedRings: 0,
    maxHeightM: 0,
  };
  return {
    streetGraph: streetGraph
      ? {
          ways: streetGraph.parsed.ways.length,
          nodes: streetGraph.graph.nodes.size,
          edges: streetGraph.graph.edges.length,
          highwayHistogram: histogram(
            streetGraph.parsed.ways,
            (way) => way.tags.highway ?? "(missing)",
          ),
          surfaceHistogram: histogram(
            streetGraph.parsed.ways,
            (way) => way.tags.surface ?? "(missing)",
          ),
          stats: { ...streetGraph.graph.stats, ...streetGraph.parsed.stats },
        }
      : emptyStreets,
    buildings: buildings
      ? {
          accepted: buildings.result.buildings.length,
          rejected: buildings.result.stats.rejected,
          byFeatureCode: buildings.result.stats.byFeatureCode,
          byPublishedStatus: buildings.result.stats.byPublishedStatus,
          known: buildings.result.stats.known,
          fallback: buildings.result.stats.fallback,
          unknown: buildings.result.stats.unknown,
          repairedRings: buildings.result.stats.repairedRings,
          maxHeightM: buildings.result.stats.maxHeightM,
        }
      : emptyBuildings,
    written,
  };
}

async function normalizeStreets(): Promise<{
  document: {
    streets: { nodes: StreetNode[]; edges: StreetEdge[] };
    recipe: string;
    osmSnapshotTimestamp: number | null;
  };
  graph: ReturnType<typeof buildStreetGraph>;
  parsed: Awaited<ReturnType<typeof parseRoads>>;
}> {
  const { receipts } = await readReceipts();
  const pbfReceipt = receipts.find((receipt) => receipt.id === "osm-new-york");
  if (!pbfReceipt) throw new Error("no OSM receipt; run acquire first");
  const pbfPath = rootPath("raw", "new-york-260918.osm.pbf");
  const digest = sha256Hex(await readFile(pbfPath));
  if (digest !== pbfReceipt.sha256) {
    throw new Error(
      `PBF digest changed since the receipt (${digest} != ${pbfReceipt.sha256}); re-run acquire`,
    );
  }
  const parsed = await parseRoads(pbfPath);
  const graph = buildStreetGraph(parsed.ways, parsed.coords);
  const nodes = [...graph.nodes.values()].sort((a, b) => a.id - b.id);
  const edges = [...graph.edges].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    document: {
      streets: { nodes, edges },
      recipe: "nyc-navigation/recipe-v1",
      osmSnapshotTimestamp: parsed.replicationTimestamp,
    },
    graph,
    parsed,
  };
}

async function normalizeBuildingsFromRaw(): Promise<{
  result: ReturnType<typeof normalizeBuildings>;
}> {
  const { receipts } = await readReceipts();
  const buildingsReceipt = receipts.find((receipt) => receipt.id === "nyc-building-footprints");
  if (!buildingsReceipt) throw new Error("no building receipt; run acquire first");
  const pagesDirectory = rootPath("raw", "buildings-pages");
  const count = Math.ceil(BUILDINGS_EXPECTED_COUNT / BUILDINGS_PAGE_SIZE);
  const pages = await readBuildingPages(pagesDirectory, count);

  const hash = createHash("sha256");
  for (const page of pages) hash.update(page);
  const pagesSha = hash.digest("hex");
  if (pagesSha !== buildingsReceipt.sha256) {
    throw new Error(
      `building pages changed since the receipt (${pagesSha} != ${buildingsReceipt.sha256}); re-run acquire`,
    );
  }
  return { result: normalizeBuildings(pages) };
}
