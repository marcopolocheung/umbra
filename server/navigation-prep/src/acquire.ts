import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NavigationSourceReceipt } from "../../../app/lib/navigationData/shardContract";
import { NAVIGATION_SOURCE_PLAN, NYC_BUILDINGS_LAYER_URL, BUILDINGS_PAGE_SIZE } from "./sources";

export { BUILDINGS_PAGE_SIZE };
import { fileSha256, requireRoot, rootPath } from "./util";

/**
 * `acquire --plan` is observational: a HEAD request and a count query, no
 * writes. `acquire --execute` downloads the dated New York PBF and the ordered
 * building-footprint pages into raw/ and writes raw/source-receipts.json,
 * idempotent like transit-prep's: matching local bytes skip the network.
 *
 * The building layer updates weekly, so a receipt pins exactly the page
 * bodies on disk plus the catalog `data_updated_at`; `validate` fails when
 * the upstream count has drifted from the pinned release.
 */

/** Feature count of the release pinned on 2026-09-19 (catalog `count`). */
export const BUILDINGS_EXPECTED_COUNT = 1_083_030;

function pageName(index: number): string {
  return `${String(index).padStart(5, "0")}.json`;
}

async function downloadToFile(url: string, path: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`GET ${url}: ${response.status}`);
  await mkdir(join(path, ".."), { recursive: true });
  const stream = createWriteStream(path);
  try {
    await response.body.pipeTo(
      new WritableStream<Uint8Array>({
        write: (chunk) => {
          stream.write(Buffer.from(chunk));
        },
        close: () => {
          stream.end();
        },
        abort: (reason) => {
          stream.destroy(reason instanceof Error ? reason : undefined);
        },
      }),
    );
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

/** Reads the receipts file, or null when it does not exist yet. */
async function readReceiptsSafe(): Promise<unknown | null> {
  try {
    return await readReceipts();
  } catch {
    return null;
  }
}

async function buildingCount(): Promise<number | null> {
  try {
    const response = await fetch(
      `${NYC_BUILDINGS_LAYER_URL}/query?where=1=1&returnCountOnly=true&f=json`,
      { signal: AbortSignal.timeout(45_000) },
    );
    if (!response.ok) return null;
    return ((await response.json()) as { count?: number }).count ?? null;
  } catch {
    return null;
  }
}

async function catalogUpdatedAt(): Promise<string | null> {
  const response = await fetch(
    "https://data.cityofnewyork.us/api/catalog/v1?domains=data.cityofnewyork.us&q=building%20footprints",
  );
  if (!response.ok) return null;
  const json = (await response.json()) as {
    results?: Array<{ resource?: { data_updated_at?: string } }>;
  };
  return json.results?.[0]?.resource?.data_updated_at ?? null;
}

async function fetchPage(offset: number): Promise<void> {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "OBJECTID,DOITT_ID,FEATURE_CODE,HEIGHT_ROOF,LAST_STATUS_TYPE,LAST_EDITED_DATE",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    resultRecordCount: String(BUILDINGS_PAGE_SIZE),
    resultOffset: String(offset),
    orderByFields: "OBJECTID ASC",
  });
  const url = `${NYC_BUILDINGS_LAYER_URL}/query?${params.toString()}`;
  // The feature service occasionally stalls a request; fail fast and retry
  // rather than wedging the whole acquisition.
  const path = join(
    rootPath("raw", "buildings-pages"),
    pageName(Math.floor(offset / BUILDINGS_PAGE_SIZE)),
  );
  const attempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (response.ok) {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error && attempt < attempts) continue;
      if (body.error) throw new Error(`page ${offset}: ${body.error.message}`);
      await writeFile(path, `${JSON.stringify(body)}\n`);
      return;
    }
    if (attempt >= attempts) throw new Error(`GET page ${offset}: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
  }
}

export interface CheckedSource {
  id: string;
  url: string;
  bytes: number | null;
  upstreamModified: string | null;
  note: string;
}

export async function acquirePlan(): Promise<{ root: string; sources: CheckedSource[] }> {
  const pbf = NAVIGATION_SOURCE_PLAN.find((source) => source.id === "osm-new-york")!;
  const response = await fetch(pbf.url, { method: "HEAD", redirect: "follow" });
  if (!response.ok) throw new Error(`HEAD ${pbf.url}: ${response.status}`);
  const bytes = Number(response.headers.get("content-length") ?? "0") || null;
  const count = await buildingCount();
  return {
    root: requireRoot(),
    sources: [
      {
        id: "osm-new-york",
        url: pbf.url,
        bytes,
        upstreamModified: response.headers.get("last-modified"),
        note: "dated Geofabrik extract",
      },
      {
        id: "nyc-building-footprints",
        url: `${NYC_BUILDINGS_LAYER_URL}/query?...`,
        bytes: null,
        upstreamModified: await catalogUpdatedAt(),
        note:
          count === null
            ? "count query failed"
            : `${count} features, ${Math.ceil(count / BUILDINGS_PAGE_SIZE)} ordered pages of ${BUILDINGS_PAGE_SIZE}`,
      },
    ],
  };
}

export interface SourceAcquireResult {
  receipt: NavigationSourceReceipt;
  skipped: boolean;
}

export interface AcquireResult {
  receipts: SourceAcquireResult[];
  counts: { pbfBytes: number; buildingPages: number; expectedFeatures: number };
  written: { receipts: string; pagesDirectory: string };
}

export async function acquireExecute(): Promise<AcquireResult> {
  const root = requireRoot();
  const raw = join(root, "raw");
  const pagesDirectory = join(raw, "buildings-pages");
  await mkdir(pagesDirectory, { recursive: true });

  const pbfSource = NAVIGATION_SOURCE_PLAN.find((source) => source.id === "osm-new-york")!;
  const pbfPath = join(raw, "new-york-260918.osm.pbf");
  let pbfBytes = 0;
  try {
    pbfBytes = (await stat(pbfPath)).size;
  } catch {
    pbfBytes = 0;
  }
  let downloadedPbf = false;
  const pbfKnown = async (): Promise<boolean> => {
    if (pbfBytes <= 0) return false;
    const prior = await readReceiptsSafe();
    if (!prior) return false;
    const receipt = (prior as { receipts: Array<{ id: string; sha256: string }> }).receipts?.find(
      (entry) => entry.id === "osm-new-york",
    );
    return Boolean(receipt && (await fileSha256(pbfPath)) === receipt.sha256);
  };
  if (!(await pbfKnown())) {
    // Missing, partial, or no longer matching its receipt: fetch pinned bytes.
    await downloadToFile(pbfSource.url, pbfPath);
    pbfBytes = (await stat(pbfPath)).size;
    downloadedPbf = true;
  }

  const total = await buildingCount();
  if (total !== BUILDINGS_EXPECTED_COUNT) {
    throw new Error(
      `building feature count drifted from the pinned release (${String(total)} != ${BUILDINGS_EXPECTED_COUNT}); re-pin before acquiring`,
    );
  }
  const pageCount = Math.ceil(total / BUILDINGS_PAGE_SIZE);
  for (let index = 0; index < pageCount; index += 1) {
    const path = join(pagesDirectory, pageName(index));
    let existingBytes = 0;
    try {
      existingBytes = (await stat(path)).size;
    } catch {
      existingBytes = 0;
    }
    if (existingBytes <= 0) {
      await fetchPage(index * BUILDINGS_PAGE_SIZE);
      if (index % 50 === 0) {
        process.stderr.write(`buildings pages: ${index + 1}/${pageCount}\n`);
      }
    }
  }

  let pageBytes = 0;
  for (let index = 0; index < pageCount; index += 1) {
    pageBytes += (await stat(join(pagesDirectory, pageName(index)))).size;
  }

  const pbfHead = await fetch(pbfSource.url, { method: "HEAD", redirect: "follow" });
  const receipts: NavigationSourceReceipt[] = [
    {
      id: "osm-new-york",
      release: "Geofabrik New York extract 260918 (latest → dated resolution)",
      url: pbfSource.url,
      bytes: pbfBytes,
      timestamp: pbfHead.headers.get("last-modified") ?? "unrecorded",
      sha256: await fileSha256(pbfPath),
    },
    {
      id: "nyc-building-footprints",
      release: `Building Footprints ${(await catalogUpdatedAt()) ?? "unknown"} (${total} features)`,
      url: `${NYC_BUILDINGS_LAYER_URL}/query (ordered pages, page size ${BUILDINGS_PAGE_SIZE})`,
      bytes: pageBytes,
      timestamp: (await catalogUpdatedAt()) ?? "unrecorded",
      sha256: await hashPages(pagesDirectory, pageCount),
    },
  ];

  const receiptsPath = join(raw, "source-receipts.json");
  await writeFile(
    receiptsPath,
    `${JSON.stringify({ version: 1, acquiredAt: new Date().toISOString(), receipts }, null, 2)}\n`,
  );

  return {
    receipts: receipts.map((receipt) => ({
      receipt,
      skipped: receipt.id === "osm-new-york" ? !downloadedPbf : false,
    })),
    counts: { pbfBytes, buildingPages: pageCount, expectedFeatures: total },
    written: { receipts: receiptsPath, pagesDirectory },
  };
}

async function hashPages(directory: string, count: number): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (let index = 0; index < count; index += 1) {
    hash.update(await readFile(join(directory, pageName(index))));
  }
  return hash.digest("hex");
}

export async function readReceipts(): Promise<{
  version: 1;
  acquiredAt: string;
  receipts: NavigationSourceReceipt[];
}> {
  const path = rootPath("raw", "source-receipts.json");
  const value = JSON.parse(await readFile(path, "utf8")) as {
    version: 1;
    acquiredAt: string;
    receipts: NavigationSourceReceipt[];
  };
  if (value.version !== 1 || value.receipts.length !== 2) {
    throw new Error("raw/source-receipts.json is malformed");
  }
  return value;
}
