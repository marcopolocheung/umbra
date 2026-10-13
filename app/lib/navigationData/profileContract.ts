/** Exact annual profiles: side-major copies of the frozen daylight-union slots. */
import type {
  NavigationManifest,
  NavigationShadeShard,
  NavigationSignatureIndex,
} from "./shardContract";
export const PROFILE_PAGE_SIDES = 32;
export const MAX_PROFILE_INDEX_BYTES = 512_000;
export const MAX_PROFILE_CELL_INDEX_BYTES = 256_000;
export const MAX_PROFILE_PAYLOAD_BYTES = 32_000_000;
export interface ProfileRef {
  key: "profiles/index.json";
  bytes: number;
  sha256: string;
  cells: number;
  payloadBytes: number;
  indexBytes: number;
}
export interface ProfileCellRef {
  key: string;
  bytes: number;
  sha256: string;
}
export interface ProfileIndex {
  version: 1;
  kind: "profiles";
  generation: string;
  model: string;
  daySlots: number[];
  pageSides: 32;
  cells: ProfileCellRef[];
}
export interface ProfileCellIndex {
  version: 1;
  kind: "profile-cell";
  shadeKey: string;
  segmentsSha256: string;
  sourceSha256: string;
  sides: number;
  payload: { key: string; bytes: number; sha256: string };
  pageHashes: string[];
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function keys(v: unknown, allowed: string[]): asserts v is Record<string, unknown> {
  if (
    !record(v) ||
    Object.keys(v).some((k) => !allowed.includes(k)) ||
    allowed.some((k) => !Object.hasOwn(v, k))
  )
    throw new Error("invalid profile contract");
}
export function parseProfileRef(v: unknown): ProfileRef {
  keys(v, ["key", "bytes", "sha256", "cells", "payloadBytes", "indexBytes"]);
  if (
    v.key !== "profiles/index.json" ||
    !positive(v.bytes) ||
    v.bytes > MAX_PROFILE_INDEX_BYTES ||
    !hash(v.sha256) ||
    !positive(v.cells) ||
    !positive(v.payloadBytes) ||
    !positive(v.indexBytes)
  )
    throw new Error("invalid profile ref");
  return v as unknown as ProfileRef;
}
export function parseProfileIndex(
  v: unknown,
  manifest: NavigationManifest,
  signatures: NavigationSignatureIndex,
): ProfileIndex {
  keys(v, ["version", "kind", "generation", "model", "daySlots", "pageSides", "cells"]);
  if (
    v.version !== 1 ||
    v.kind !== "profiles" ||
    v.generation !== manifest.generation ||
    v.model !== signatures.model.version ||
    v.pageSides !== PROFILE_PAGE_SIDES ||
    JSON.stringify(v.daySlots) !== JSON.stringify(signatures.model.daySlots) ||
    !Array.isArray(v.cells) ||
    v.cells.length !== manifest.profiles?.cells
  )
    throw new Error("invalid profile index");
  const seen = new Set<string>();
  for (const c of v.cells) {
    keys(c, ["key", "bytes", "sha256"]);
    if (
      typeof c.key !== "string" ||
      !/^profiles\/[a-z0-9-]{1,64}\.json$/.test(c.key) ||
      !positive(c.bytes) ||
      c.bytes > MAX_PROFILE_CELL_INDEX_BYTES ||
      !hash(c.sha256) ||
      seen.has(c.key) ||
      !manifest.shadeShards?.some(
        (s) => s.key === (c.key as string).replace("profiles/", "shades/"),
      )
    )
      throw new Error("invalid profile cell ref");
    seen.add(c.key);
  }
  return v as unknown as ProfileIndex;
}
export function parseProfileCell(
  v: unknown,
  ref: ProfileCellRef,
  index: ProfileIndex,
  shade: NavigationShadeShard,
): ProfileCellIndex {
  keys(v, [
    "version",
    "kind",
    "shadeKey",
    "segmentsSha256",
    "sourceSha256",
    "sides",
    "payload",
    "pageHashes",
  ]);
  keys(v.payload, ["key", "bytes", "sha256"]);
  if (
    v.version !== 1 ||
    v.kind !== "profile-cell" ||
    v.shadeKey !== ref.key.replace("profiles/", "shades/") ||
    v.sourceSha256 !== shade.payload.sha256 ||
    !hash(v.segmentsSha256) ||
    v.sides !== shade.segments.length * 2 ||
    v.payload.key !== ref.key.replace(/\.json$/, ".bin") ||
    v.payload.bytes !== shade.segments.length * 2 * index.daySlots.length ||
    (v.payload.bytes as number) > MAX_PROFILE_PAYLOAD_BYTES ||
    !hash(v.payload.sha256) ||
    !Array.isArray(v.pageHashes) ||
    v.pageHashes.length !== Math.ceil((shade.segments.length * 2) / PROFILE_PAGE_SIDES) ||
    !v.pageHashes.every(hash)
  )
    throw new Error("invalid profile cell index");
  return v as unknown as ProfileCellIndex;
}
