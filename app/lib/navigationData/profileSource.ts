/** Verified selective annual-profile reads through the existing static origin. */
import {
  parseProfileIndex,
  parseProfileCell,
  PROFILE_PAGE_SIDES,
  type ProfileCellIndex,
  type ProfileIndex,
} from "./profileContract";
import {
  getOrFetch,
  withCallerSignal,
  shardUrl,
  sha256Hex,
  type NavigationSnapshot,
  type NavigationRequestOptions,
} from "./remoteNavigation";
import type { NavigationShadeShard, NavigationSignatureIndex } from "./shardContract";
const pages = new Map<string, Uint8Array>();
let heldBytes = 0;
function remember(key: string, bytes: Uint8Array) {
  if (pages.has(key)) return;
  pages.set(key, bytes);
  heldBytes += bytes.length;
  while (heldBytes > 16 * 1024 * 1024) {
    const first = pages.keys().next().value!;
    heldBytes -= pages.get(first)!.length;
    pages.delete(first);
  }
}
async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("profile body absent");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("profile response exceeds byte budget");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function json(
  snapshot: NavigationSnapshot,
  ref: { key: string; bytes: number; sha256: string },
  options?: NavigationRequestOptions,
) {
  const url = shardUrl(snapshot.base, snapshot.generation, ref.key);
  return withCallerSignal(
    getOrFetch(url, async () => {
      const response = await (options?.fetchFn ?? fetch)(url, { cache: "force-cache" });
      if (!response.ok) throw new Error("profile index request failed");
      const bytes = await boundedBytes(response, ref.bytes);
      if (bytes.length !== ref.bytes || (await sha256Hex(bytes)) !== ref.sha256)
        throw new Error("profile index integrity mismatch");
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    }),
    options?.signal,
  );
}
export async function loadProfileIndex(
  snapshot: NavigationSnapshot,
  signatures: NavigationSignatureIndex,
  options?: NavigationRequestOptions,
) {
  if (!snapshot.manifest.profiles) return null;
  return parseProfileIndex(
    await json(snapshot, snapshot.manifest.profiles, options),
    snapshot.manifest,
    signatures,
  );
}
export async function loadProfileCell(
  snapshot: NavigationSnapshot,
  index: ProfileIndex,
  shade: NavigationShadeShard,
  options?: NavigationRequestOptions,
) {
  const ref = index.cells.find(
    (c) => c.key === shade.payload.key.replace("shades/", "profiles/").replace(/\.bin$/, ".json"),
  );
  if (!ref) throw new Error("profile cell absent");
  const cell = parseProfileCell(await json(snapshot, ref, options), ref, index, shade);
  if (
    cell.segmentsSha256 !==
    (await sha256Hex(new TextEncoder().encode(JSON.stringify(shade.segments))))
  )
    throw new Error("profile row order mismatch");
  return cell;
}
export interface ProfileRead {
  cell: ProfileCellIndex;
  rows: number[];
}
export async function loadAnnualProfiles(
  snapshot: NavigationSnapshot,
  index: ProfileIndex,
  reads: ProfileRead[],
  options?: NavigationRequestOptions,
) {
  if (reads.reduce((n, r) => n + new Set(r.rows).size, 0) > 501)
    throw new Error("profile shortlist exceeds budget");
  const days = index.daySlots.length,
    pageBytes = PROFILE_PAGE_SIDES * days;
  const jobs: Array<() => Promise<void>> = [];
  const result = new Map<string, Uint8Array>();
  for (const { cell, rows } of reads) {
    const url = shardUrl(snapshot.base, snapshot.generation, cell.payload.key);
    const pageKey = (p: number) => `${url}:${cell.payload.sha256}:${p}`;
    const needed = [
      ...new Set(
        rows.map((row) => {
          if (!Number.isInteger(row) || row < 0 || row >= cell.sides)
            throw new Error("invalid profile row");
          return Math.floor(row / PROFILE_PAGE_SIDES);
        }),
      ),
    ].sort((a, b) => a - b);
    const missing = needed.filter((p) => !pages.has(pageKey(p)));
    const runs: number[][] = [];
    for (const p of missing) {
      const last = runs.at(-1);
      if (last && p === last.at(-1)! + 1 && last.length < Math.floor((256 * 1024) / pageBytes))
        last.push(p);
      else runs.push([p]);
    }
    for (const run of runs)
      jobs.push(async () => {
        const start = run[0] * pageBytes,
          end = Math.min((run.at(-1)! + 1) * pageBytes, cell.payload.bytes);
        const shared = getOrFetch(`${pageKey(run[0])}:${end}`, async () => {
          const response = await (options?.fetchFn ?? fetch)(url, {
            headers: { Range: `bytes=${start}-${end - 1}` },
            cache: "force-cache",
          });
          if (
            response.status !== 206 ||
            response.headers.get("Content-Range") !==
              `bytes ${start}-${end - 1}/${cell.payload.bytes}`
          ) {
            await response.body?.cancel();
            throw new Error("profile range mismatch");
          }
          const raw = await boundedBytes(response, end - start);
          if (raw.length !== end - start) throw new Error("profile range length mismatch");
          for (const p of run) {
            const bytes = raw.slice(
              p * pageBytes - start,
              Math.min((p + 1) * pageBytes - start, raw.length),
            );
            if ((await sha256Hex(bytes)) !== cell.pageHashes[p])
              throw new Error("profile page hash mismatch");
          }
          return raw;
        });
        const raw = await withCallerSignal(shared, options?.signal);
        for (const p of run) {
          const bytes = raw.slice(
            p * pageBytes - start,
            Math.min((p + 1) * pageBytes - start, raw.length),
          );
          remember(pageKey(p), bytes);
          result.set(`${cell.payload.key}/page/${p}`, bytes);
        }
      });
    // Row extraction happens after all requests finish; cache may evict under
    // concurrent queries, so retain this request's pages as they are acquired.
    for (const p of needed) {
      const cached = pages.get(pageKey(p));
      if (cached) result.set(`${cell.payload.key}/page/${p}`, cached);
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, jobs.length) }, async () => {
      while (next < jobs.length) {
        if (options?.signal?.aborted) throw options.signal.reason;
        await jobs[next++]();
      }
    }),
  );
  const rows = new Map<string, Uint8Array>();
  for (const read of reads)
    for (const row of read.rows) {
      const p = Math.floor(row / PROFILE_PAGE_SIDES);
      const raw = result.get(`${read.cell.payload.key}/page/${p}`);
      if (!raw) throw new Error("profile page missing");
      rows.set(
        `${read.cell.shadeKey}/${row}`,
        raw.subarray((row % PROFILE_PAGE_SIDES) * days, ((row % PROFILE_PAGE_SIDES) + 1) * days),
      );
    }
  return rows;
}
