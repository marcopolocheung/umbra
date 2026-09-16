/** The small, mutable entry point to an otherwise immutable browser-tile generation. */
export interface ShadowCurrent {
  version: 1;
  dataset: "nyc-shadow";
  generation: string;
  manifestPath: string;
  manifestSha256: string;
  tilePathTemplate: string;
  tileCount: number;
}

const generationPattern = /^nyc-[a-f0-9]{32}(?:-[a-z0-9-]{1,48})?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function configuredBase(): string | undefined {
  const value = (import.meta.env.VITE_SHADOW_API_BASE ?? "").trim().replace(/\/$/, "");
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("VITE_SHADOW_API_BASE must be an HTTPS URL"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
    throw new Error("VITE_SHADOW_API_BASE must be an HTTPS origin without a path");
  return url.origin;
}

export function shadowApiBase(): string | undefined {
  return configuredBase();
}

/** Reject malformed pointers before their paths are used in browser requests. */
export function parseShadowCurrent(value: unknown): ShadowCurrent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid NYC shadow pointer");
  const item = value as Record<string, unknown>;
  const generation = item.generation;
  const manifestPath = item.manifestPath;
  const tilePathTemplate = item.tilePathTemplate;
  const tileCount = item.tileCount;
  if (
    item.version !== 1 || item.dataset !== "nyc-shadow" || typeof generation !== "string" || !generationPattern.test(generation) ||
    typeof manifestPath !== "string" || manifestPath !== `/_shadow/generations/${generation}/manifest.json` ||
    typeof item.manifestSha256 !== "string" || !sha256Pattern.test(item.manifestSha256) ||
    typeof tilePathTemplate !== "string" || tilePathTemplate !== `/_shadow/generations/${generation}/tiles/{z}-{x}-{y}.smb` ||
    typeof tileCount !== "number" || !Number.isInteger(tileCount) || tileCount <= 0
  ) throw new Error("invalid NYC shadow pointer");
  return {
    version: 1,
    dataset: "nyc-shadow",
    generation,
    manifestPath,
    manifestSha256: item.manifestSha256,
    tilePathTemplate,
    tileCount,
  };
}

/** Fetches only the tiny generation pointer—not the manifest or any tile data. */
export async function loadShadowCurrent(signal?: AbortSignal): Promise<ShadowCurrent | undefined> {
  const base = configuredBase();
  if (!base) return undefined;
  const response = await fetch(`${base}/_shadow/current.json`, {
    signal,
    headers: { Accept: "application/json" },
    // `current.json` has a short Worker cache TTL. Revalidate it so a future
    // promotion is noticed without bypassing the CDN's ETag handling.
    cache: "no-cache",
  });
  if (!response.ok) throw new Error(`NYC shadow pointer request failed (${response.status})`);
  return parseShadowCurrent(await response.json());
}
