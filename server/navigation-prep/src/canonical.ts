import { createHash } from "node:crypto";

/** Stable JSON for generation ids, fixture bytes, and source receipts. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])]),
    );
  }
  return value;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonBytes(value: unknown): Uint8Array {
  return utf8(`${canonicalJson(value)}\n`);
}
