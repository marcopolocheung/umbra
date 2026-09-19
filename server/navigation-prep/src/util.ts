import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** The preparation root. Commands that touch the filesystem require it. */
export function requireRoot(): string {
  const root = process.env.NAVIGATION_PREP_ROOT;
  if (!root) {
    throw new Error("NAVIGATION_PREP_ROOT is required (absolute path outside git)");
  }
  if (!root.startsWith("/")) throw new Error("NAVIGATION_PREP_ROOT must be absolute");
  return root;
}

export function rootPath(...parts: string[]): string {
  return join(requireRoot(), ...parts);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function fileSha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return sha256Hex(bytes);
}

export async function fileBytes(path: string): Promise<number> {
  return (await stat(path)).size;
}

export function parseIsoStrict(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)
  ) {
    throw new Error(`invalid ISO timestamp: ${String(value)}`);
  }
  return value;
}
