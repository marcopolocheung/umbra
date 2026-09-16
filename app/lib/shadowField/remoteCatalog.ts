import {
  MAX_GENERATION_ROOT_BYTES,
  MAX_BOUNDS_BYTES,
  MAX_COVERAGE_BYTES,
  MAX_NOTICES_BYTES,
  parseCoverageIndex,
  parseGenerationRoot,
  parseGenerationNotices,
  parseTileBoundsArtifact,
  type BoundsLevel,
  type CoverageIndex,
  type GenerationNotices,
  type GenerationRoot,
  type TileBoundsArtifact,
} from "./v2/artifacts";

/** The small, mutable entry point to an otherwise immutable browser-tile generation. */
export type ShadowCurrent = ShadowCurrentV1 | ShadowCurrentV2;

export interface ShadowCurrentV1 {
  version: 1;
  dataset: "nyc-shadow";
  generation: string;
  manifestPath: string;
  manifestSha256: string;
  tilePathTemplate: string;
  tileCount: number;
}

/**
 * v2 pointers name one immutable generation-root document instead of
 * duplicating every artifact field in the mutable pointer.
 */
export interface ShadowCurrentV2 {
  version: 2;
  dataset: "nyc-shadow";
  generation: string;
  generationPath: string;
  generationSha256: string;
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

function tileTemplate(generation: string, value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === `/_shadow/generations/${generation}/tiles/{z}-{x}-{y}.smb`
  );
}

/** Reject malformed pointers before their paths are used in browser requests. */
export function parseShadowCurrent(value: unknown): ShadowCurrent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid NYC shadow pointer");
  const item = value as Record<string, unknown>;
  const generation = item.generation;
  if (
    typeof generation !== "string" ||
    !generationPattern.test(generation) ||
    item.dataset !== "nyc-shadow" ||
    typeof item.tileCount !== "number" ||
    !Number.isInteger(item.tileCount) ||
    item.tileCount <= 0 ||
    !tileTemplate(generation, item.tilePathTemplate)
  )
    throw new Error("invalid NYC shadow pointer");
  if (item.version === 1) {
    if (
      typeof item.manifestPath !== "string" ||
      item.manifestPath !== `/_shadow/generations/${generation}/manifest.json` ||
      typeof item.manifestSha256 !== "string" ||
      !sha256Pattern.test(item.manifestSha256)
    )
      throw new Error("invalid NYC shadow pointer");
    return {
      version: 1,
      dataset: "nyc-shadow",
      generation,
      manifestPath: item.manifestPath,
      manifestSha256: item.manifestSha256,
      tilePathTemplate: item.tilePathTemplate as string,
      tileCount: item.tileCount,
    };
  }
  if (item.version === 2) {
    if (
      typeof item.generationPath !== "string" ||
      item.generationPath !== `/_shadow/generations/${generation}/generation.json` ||
      typeof item.generationSha256 !== "string" ||
      !sha256Pattern.test(item.generationSha256)
    )
      throw new Error("invalid NYC shadow pointer");
    return {
      version: 2,
      dataset: "nyc-shadow",
      generation,
      generationPath: item.generationPath,
      generationSha256: item.generationSha256,
      tilePathTemplate: item.tilePathTemplate as string,
      tileCount: item.tileCount,
    };
  }
  throw new Error("invalid NYC shadow pointer");
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetches the immutable generation root and verifies its bytes against the
 * pointer before parsing. Tested but uncalled until PR3's lazy NYC loader.
 */
export async function loadGenerationRoot(
  current: ShadowCurrentV2,
  signal?: AbortSignal,
): Promise<GenerationRoot> {
  const base = configuredBase();
  if (!base) throw new Error("VITE_SHADOW_API_BASE is not configured");
  const response = await fetch(`${base}${current.generationPath}`, {
    signal,
    headers: { Accept: "application/json" },
    cache: "force-cache",
  });
  if (!response.ok) throw new Error(`NYC shadow generation request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_GENERATION_ROOT_BYTES)
    throw new Error("NYC shadow generation root exceeds its budget");
  if ((await sha256Hex(bytes)) !== current.generationSha256)
    throw new Error("NYC shadow generation hash mismatch");
  const root = parseGenerationRoot(JSON.parse(new TextDecoder().decode(bytes)));
  if (root.generation !== current.generation) throw new Error("NYC shadow generation mismatch");
  if (root.tileCount !== current.tileCount || root.tilePathTemplate !== current.tilePathTemplate)
    throw new Error("NYC shadow pointer/root tile contract mismatch");
  if (root.availableTileCount !== root.tileCount || root.activationTileCount > root.availableTileCount)
    throw new Error("NYC shadow generation count contract mismatch");
  return root;
}

type CompactArtifact = "coverage" | "bounds" | "notices";
const compactBudget: Record<CompactArtifact, number> = {
  coverage: MAX_COVERAGE_BYTES,
  bounds: MAX_BOUNDS_BYTES,
  notices: MAX_NOTICES_BYTES,
};

/** Fetch an immutable compact artifact only through a verified generation root.
 * The byte count and digest are both checked before JSON parsing, preventing a
 * root from being used as a path hint without also enforcing its binding. */
async function loadCompactArtifact(
  root: GenerationRoot,
  name: CompactArtifact,
  signal?: AbortSignal,
): Promise<{ value: unknown; bytesLength: number }> {
  const base = configuredBase();
  if (!base) throw new Error("VITE_SHADOW_API_BASE is not configured");
  const ref = root.artifacts[name];
  const response = await fetch(`${base}${ref.path}`, { signal, headers: { Accept: "application/json" }, cache: "force-cache" });
  if (!response.ok) throw new Error(`NYC shadow ${name} request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== ref.bytes || bytes.byteLength > compactBudget[name])
    throw new Error(`NYC shadow ${name} byte contract mismatch`);
  if ((await sha256Hex(bytes)) !== ref.sha256) throw new Error(`NYC shadow ${name} hash mismatch`);
  try { return { value: JSON.parse(new TextDecoder().decode(bytes)), bytesLength: bytes.byteLength }; }
  catch { throw new Error(`NYC shadow ${name} is invalid JSON`); }
}

export async function loadCoverageIndex(root: GenerationRoot, signal?: AbortSignal): Promise<CoverageIndex> {
  const artifact = await loadCompactArtifact(root, "coverage", signal);
  const coverage = parseCoverageIndex(artifact.value, { generation: root.generation, bytesLength: artifact.bytesLength });
  if (coverage.availableTileCount !== root.availableTileCount || coverage.availableTileCount !== root.tileCount || coverage.activationTileCount !== root.activationTileCount)
    throw new Error("NYC shadow coverage/root count mismatch");
  return coverage;
}

export async function loadTileBounds(root: GenerationRoot, signal?: AbortSignal): Promise<TileBoundsArtifact> {
  const artifact = await loadCompactArtifact(root, "bounds", signal);
  const bounds = parseTileBoundsArtifact(artifact.value, { generation: root.generation, bytesLength: artifact.bytesLength }, root.tileCount);
  if (bounds.tileCount !== root.availableTileCount) throw new Error("NYC shadow bounds/root count mismatch");
  return bounds;
}

export async function loadGenerationNotices(root: GenerationRoot, signal?: AbortSignal): Promise<GenerationNotices> {
  const artifact = await loadCompactArtifact(root, "notices", signal);
  return parseGenerationNotices(artifact.value, { generation: root.generation, bytesLength: artifact.bytesLength });
}

export { parseGenerationRoot };
export type { BoundsLevel, CoverageIndex, GenerationNotices, GenerationRoot, TileBoundsArtifact };
