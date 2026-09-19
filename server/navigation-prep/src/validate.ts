import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILDINGS_EXPECTED_COUNT, BUILDINGS_PAGE_SIZE, readReceipts } from "./acquire";
import { fileSha256, rootPath } from "./util";

/**
 * Validates the raw acquisition against its receipts: PBF digest, building
 * page completeness, per-page record counts, and monotonically ordered
 * OBJECTID pagination — so a dropped or duplicated page is caught before any
 * generation can be built on it.
 */

export interface ValidateResult {
  pbf: { bytes: number; sha256: string; matchesReceipt: boolean };
  buildings: {
    pages: number;
    features: number;
    expected: number;
    lastObjectId: number;
    monotonic: boolean;
    matchedReceiptHash: boolean;
  };
}

interface Page {
  features?: Array<{ attributes?: Record<string, unknown> }>;
}

export async function validate(): Promise<ValidateResult> {
  const { receipts } = await readReceipts();
  const pbfReceipt = receipts.find((receipt) => receipt.id === "osm-new-york");
  const buildingsReceipt = receipts.find((receipt) => receipt.id === "nyc-building-footprints");
  if (!pbfReceipt || !buildingsReceipt) throw new Error("receipts are incomplete; run acquire");

  const pbfPath = rootPath("raw", "new-york-260918.osm.pbf");
  const pbfBytes = await readFile(pbfPath);
  const pbfSha = fileSha256(pbfPath);
  if ((await pbfSha) !== pbfReceipt.sha256) {
    throw new Error("PBF digest does not match the receipt; re-run acquire");
  }

  const count = Math.ceil(BUILDINGS_EXPECTED_COUNT / BUILDINGS_PAGE_SIZE);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  let total = 0;
  let monotonic = true;
  let lastObjectId = -1;
  for (let index = 0; index < count; index += 1) {
    const text = await readFile(
      join(rootPath("raw", "buildings-pages"), `${String(index).padStart(5, "0")}.json`),
      "utf8",
    );
    hash.update(text);
    const page = JSON.parse(text) as Page;
    const features = page.features ?? [];
    const expectedOnPage =
      index < count - 1 ? BUILDINGS_PAGE_SIZE : BUILDINGS_EXPECTED_COUNT % BUILDINGS_PAGE_SIZE;
    if (features.length !== expectedOnPage) {
      throw new Error(`page ${index} has ${features.length} features, expected ${expectedOnPage}`);
    }
    for (const feature of features) {
      const objectId = feature.attributes?.OBJECTID;
      if (typeof objectId !== "number" || objectId <= lastObjectId) {
        monotonic = false;
      }
      lastObjectId = objectId as number;
    }
    total += features.length;
  }
  const matchedReceiptHash = hash.digest("hex") === buildingsReceipt.sha256;

  return {
    pbf: {
      bytes: pbfBytes.byteLength,
      sha256: await pbfSha,
      matchesReceipt: (await pbfSha) === pbfReceipt.sha256,
    },
    buildings: {
      pages: count,
      features: total,
      expected: BUILDINGS_EXPECTED_COUNT,
      lastObjectId,
      monotonic,
      matchedReceiptHash,
    },
  };
}
