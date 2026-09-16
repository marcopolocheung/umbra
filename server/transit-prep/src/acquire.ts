/**
 * Step 1: download the 7 pinned GTFS zips into raw/ and unzip to work/.
 * acquire --plan is observational (HEAD requests only, no writes).
 * acquire --execute downloads (skipping SHA-matching zips), then refreshes
 * work/<dir>/ in place and records response metadata for receipts.
 */

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { FEED_SOURCES, type FeedSource } from "./sources";
import { fileHash, requireRoot } from "./util";

const exec = promisify(execFile);

export interface AcquirePlan {
  feeds: { id: string; downloadUrl: string; bytes: number; lastModified: string }[];
}

async function head(url: string): Promise<{ bytes: number; lastModified: string }> {
  const response = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!response.ok) throw new Error(`HEAD ${url}: ${response.status}`);
  return {
    bytes: Number(response.headers.get("content-length") ?? "0"),
    lastModified: response.headers.get("last-modified") ?? "unknown",
  };
}

export async function acquirePlan(): Promise<AcquirePlan> {
  const feeds = await Promise.all(
    FEED_SOURCES.map(async (source) => ({ id: source.id, downloadUrl: source.downloadUrl, ...(await head(source.downloadUrl)) })),
  );
  return { feeds };
}

async function download(url: string, path: string, since?: string): Promise<"fresh" | "not-modified"> {
  const headers: Record<string, string> = {};
  if (since && since !== "unknown") headers["if-modified-since"] = since;
  const response = await fetch(url, { headers, redirect: "follow" });
  if (response.status === 304) return "not-modified";
  if (!response.ok || !response.body) throw new Error(`GET ${url}: ${response.status}`);
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path);
    response.body?.pipeTo(
      new WritableStream({
        write: (chunk) => void stream.write(chunk),
        close: () => {
          stream.end(resolve);
        },
        abort: (reason) => {
          stream.destroy(reason instanceof Error ? reason : undefined);
          reject(reason);
        },
      }),
    ).catch(reject);
  });
  return "fresh";
}

export interface AcquireResult {
  feeds: {
    id: string;
    bytes: number;
    sha256: string;
    lastModified: string;
    skipped: boolean;
  }[];
}

/** Download + unzip every feed. Idempotent: SHA-matching zips are not re-fetched. */
export async function acquireExecute(
  previous?: Map<string, { sha256: string; lastModified: string }>,
): Promise<AcquireResult> {
  const root = requireRoot();
  const raw = join(root, "raw");
  await mkdir(raw, { recursive: true });
  const feeds: AcquireResult["feeds"] = [];
  for (const source of FEED_SOURCES) {
    const zipPath = join(raw, `${source.id}.zip`);
    const known = previous?.get(source.id);
    let skipped = false;
    if (known) {
      try {
        if ((await fileHash(zipPath)) === known.sha256) skipped = true;
      } catch {
        skipped = false;
      }
    }
    let status: "fresh" | "not-modified" = "fresh";
    if (!skipped) {
      status = await download(source.downloadUrl, zipPath, known?.lastModified);
      skipped = status === "not-modified";
    }
    const bytes = (await stat(zipPath)).size;
    const digest = await fileHash(zipPath);
    const { lastModified } = await head(source.downloadUrl);
    await unzipRefresh(zipPath, join(root, source.workDir), source);
    feeds.push({ id: source.id, bytes, sha256: digest, lastModified, skipped });
  }
  return { feeds };
}

async function unzipRefresh(zipPath: string, workDir: string, source: FeedSource): Promise<void> {
  await mkdir(workDir, { recursive: true });
  // -o refreshes in place (same bytes, new mtimes); -q keeps output clean.
  // unzip is a standard Unix/macOS tool, same shell-out precedent as GDAL.
  await exec("unzip", ["-o", "-q", zipPath, "-d", workDir]);
  const { readdir } = await import("node:fs/promises");
  const members = (await readdir(workDir)).filter((name) => name.endsWith(".txt")).sort();
  const missing = source.requiredFiles.filter((name) => !members.includes(name));
  if (missing.length > 0) {
    throw new Error(`${source.id}: zip missing required files: ${missing.join(", ")}`);
  }
}

export async function writeFetchLog(result: AcquireResult): Promise<string> {
  const root = requireRoot();
  const path = join(root, "evidence", `acquire-${Date.now()}.json`);
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2)}\n`);
  return path;
}
