/** Repack existing verified bytes; never run the shadow model or fit PCA. */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROFILE_PAGE_SIDES,
  parseProfileCell,
  type ProfileCellIndex,
  type ProfileIndex,
} from "../../../app/lib/navigationData/profileContract";
import { canonicalJson, jsonBytes, sha256Hex } from "./canonical";
import { loadBuiltShadeShards, type BuiltShadeShard } from "./shade";
import { loadSignatureModel } from "./signatures";
import { rootPath } from "./util";
export function packProfiles(
  bytes: Uint8Array,
  sides: number,
  slots: readonly number[],
): Uint8Array {
  if (
    !Number.isSafeInteger(sides) ||
    sides < 1 ||
    !slots.length ||
    slots.some(
      (s, i) => !Number.isInteger(s) || s < 0 || s >= 768 || (i > 0 && s <= slots[i - 1]),
    ) ||
    bytes.length !== sides * 768
  )
    throw new Error("profile source length mismatch");
  const packed = new Uint8Array(sides * slots.length);
  for (let row = 0; row < sides; row++)
    for (let d = 0; d < slots.length; d++)
      packed[row * slots.length + d] = bytes[slots[d] * sides + row];
  return packed;
}
export function profilePageHashes(bytes: Uint8Array, days: number): string[] {
  const hashes: string[] = [];
  for (let p = 0; p < bytes.length; p += PROFILE_PAGE_SIDES * days)
    hashes.push(sha256Hex(bytes.subarray(p, p + PROFILE_PAGE_SIDES * days)));
  return hashes;
}
export async function profilesExecute() {
  const { model } = await loadSignatureModel();
  const shades = await loadBuiltShadeShards();
  if (!shades.length) throw new Error("no shade cells to pack");
  const dir = rootPath("work", "profiles");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let bytes = 0;
  for (const shade of shades) {
    const packed = packProfiles(shade.payloadBytes, shade.ref.segments * 2, model.daySlots);
    const cell: ProfileCellIndex = {
      version: 1,
      kind: "profile-cell",
      shadeKey: shade.indexKey,
      segmentsSha256: sha256Hex(canonicalJson(shade.index.segments)),
      sourceSha256: shade.ref.payloadSha256,
      sides: shade.ref.segments * 2,
      payload: {
        key: `profiles/${shade.cellKey}.bin`,
        bytes: packed.length,
        sha256: sha256Hex(packed),
      },
      pageHashes: profilePageHashes(packed, model.daySlots.length),
    };
    await writeFile(join(dir, `${shade.cellKey}.bin`), packed);
    await writeFile(join(dir, `${shade.cellKey}.json`), jsonBytes(cell));
    bytes += packed.length;
  }
  await writeFile(
    join(dir, "model.json"),
    jsonBytes({ model: model.version, daySlots: model.daySlots }),
  );
  return {
    cells: shades.length,
    bytes,
    daySlots: model.daySlots.length,
    pageSides: PROFILE_PAGE_SIDES,
  };
}
export async function loadBuiltProfiles(shades: BuiltShadeShard[]) {
  const dir = rootPath("work", "profiles");
  const entries = await readdir(dir).catch(() => []);
  if (!entries.length) return null;
  const { model } = await loadSignatureModel();
  const storedModel = JSON.parse(await readFile(join(dir, "model.json"), "utf8"));
  if (
    canonicalJson(storedModel) !== canonicalJson({ model: model.version, daySlots: model.daySlots })
  )
    throw new Error("stale profile model");
  const files = new Map<string, { file: string; bytes: number; sha256: string }>();
  const index: ProfileIndex = {
    version: 1,
    kind: "profiles",
    generation: "",
    model: model.version,
    daySlots: model.daySlots,
    pageSides: PROFILE_PAGE_SIDES,
    cells: [],
  };
  const claimed = new Set(["model.json"]);
  for (const shade of shades) {
    const key = shade.cellKey;
    const raw = await readFile(join(dir, `${key}.json`));
    const cell = JSON.parse(raw.toString()) as ProfileCellIndex;
    const payload = await readFile(join(dir, `${key}.bin`));
    if (
      cell.sourceSha256 !== shade.ref.payloadSha256 ||
      cell.shadeKey !== shade.indexKey ||
      cell.segmentsSha256 !== sha256Hex(canonicalJson(shade.index.segments)) ||
      cell.sides !== shade.ref.segments * 2 ||
      payload.length !== cell.sides * model.daySlots.length ||
      payload.length !== cell.payload.bytes ||
      sha256Hex(payload) !== cell.payload.sha256 ||
      canonicalJson(cell.pageHashes) !==
        canonicalJson(profilePageHashes(payload, model.daySlots.length))
    )
      throw new Error(`stale profile cell ${key}`);
    index.cells.push({ key: `profiles/${key}.json`, bytes: raw.length, sha256: sha256Hex(raw) });
    parseProfileCell(cell, index.cells[index.cells.length - 1], index, shade.index);
    files.set(`profiles/${key}.json`, {
      file: join(dir, `${key}.json`),
      bytes: raw.length,
      sha256: sha256Hex(raw),
    });
    files.set(`profiles/${key}.bin`, {
      file: join(dir, `${key}.bin`),
      bytes: payload.length,
      sha256: sha256Hex(payload),
    });
    claimed.add(`${key}.json`);
    claimed.add(`${key}.bin`);
  }
  if (entries.some((e) => !claimed.has(e))) throw new Error("unclaimed profile cells");
  return { index, files };
}
