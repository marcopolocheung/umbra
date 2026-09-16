/**
 * Step 1 (records): raw/source-receipts.json — one receipt per feed pinning
 * the URL, bytes, SHA-256, server Last-Modified, and the feed's own
 * feed_info window. Later steps refuse to run when a work tree disagrees
 * with its receipt.
 */

import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFeedInfo } from "./gtfs";
import { FEED_SOURCES, type FeedId } from "./sources";
import { fileHash, json, requireRoot, workTreeHash, writeJson } from "./util";

export interface FeedReceipt {
  id: FeedId;
  canonicalPage: string;
  downloadUrl: string;
  bytes: number;
  sha256: string;
  lastModified: string;
  feedVersion: string;
  feedStartDate: string;
  feedEndDate: string;
  workTreeHash: string;
  acquiredAt: string;
}

export interface SourceReceipts {
  version: 1;
  receipts: FeedReceipt[];
}

export function receiptsPath(): string {
  return join(requireRoot(), "raw", "source-receipts.json");
}

export async function readReceipts(): Promise<SourceReceipts> {
  return json<SourceReceipts>(receiptsPath());
}

/**
 * Assemble receipts from downloads on disk. Prefers raw/*.zip hashes;
 * falls back to work-tree hashes when only unzipped files exist (e.g. the
 * initial hand-seeded data dir), flagging provenance accordingly.
 */
export async function assembleReceipts(): Promise<{ receipts: SourceReceipts; fromZips: boolean }> {
  const root = requireRoot();
  const receipts: FeedReceipt[] = [];
  let fromZips = true;
  for (const source of FEED_SOURCES) {
    const feedInfo = loadFeedInfo(
      await readFile(join(root, source.workDir, "feed_info.txt"), "utf8"),
    );
    const zipPath = join(root, "raw", `${source.id}.zip`);
    let digest: string;
    let bytes = 0;
    try {
      bytes = (await stat(zipPath)).size;
      digest = await fileHash(zipPath);
    } catch {
      fromZips = false;
      digest = await workTreeHash(join(root, source.workDir), source.requiredFiles);
    }
    receipts.push({
      id: source.id,
      canonicalPage: source.canonicalPage,
      downloadUrl: source.downloadUrl,
      bytes,
      sha256: digest,
      lastModified: "unrecorded-seed",
      feedVersion: feedInfo.version,
      feedStartDate: feedInfo.startDate,
      feedEndDate: feedInfo.endDate,
      workTreeHash: await workTreeHash(join(root, source.workDir), source.requiredFiles),
      acquiredAt: new Date().toISOString(),
    });
  }
  const document: SourceReceipts = { version: 1, receipts };
  await writeJson(receiptsPath(), document);
  return { receipts: document, fromZips };
}

/** Fail when a work tree no longer matches its receipt. */
export async function checkWorkTrees(document: SourceReceipts): Promise<void> {
  const root = requireRoot();
  const problems: string[] = [];
  for (const receipt of document.receipts) {
    const source = FEED_SOURCES.find((item) => item.id === receipt.id);
    if (!source) {
      problems.push(`${receipt.id}: no pinned source`);
      continue;
    }
    const actual = await workTreeHash(join(root, source.workDir), source.requiredFiles);
    if (actual !== receipt.workTreeHash) {
      problems.push(`${receipt.id}: work tree changed since receipt (re-run acquire)`);
    }
  }
  if (problems.length > 0) throw new Error(`receipt mismatch:\n${problems.join("\n")}`);
}
