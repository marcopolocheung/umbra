import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export const root = process.env.SHADE_PREP_ROOT;
export function requireRoot(): string {
  if (!root || !root.startsWith("/")) throw new Error("SHADE_PREP_ROOT must be an absolute directory outside Git");
  return root;
}
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function fileHash(path: string): Promise<string> { return sha256(await readFile(path)); }
export async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
export async function writeJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
export async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.${process.pid}.tmp`; await writeJson(temporary, value); await rename(temporary, path); }
export async function files(directory: string): Promise<string[]> {
  try { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat(); } catch { return []; }
}
export async function directoryBytes(directory: string): Promise<number> { let total = 0; for (const path of await files(directory)) total += (await stat(path)).size; return total; }
export function rel(path: string): string { return relative(requireRoot(), path); }
export function safeName(value: string): string { return basename(value).replace(/[^a-zA-Z0-9._-]/g, "_"); }
