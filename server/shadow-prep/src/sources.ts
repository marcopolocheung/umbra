import type { Admission, Receipt, ReceiptId } from "./admission";

export function receipt(admission: Admission, id: ReceiptId): Receipt & { path: string; bytes: number } {
  const found = admission.receipts.find((item) => item.id === id);
  if (!found) throw new Error(`admission lacks pinned receipt ${id}`);
  return found;
}

export const receiptsForComponent = (kind: "terrain" | "buildings" | "canopy"): ReceiptId[] =>
  kind === "terrain" ? ["fabdem-v1.2"] : kind === "buildings" ? ["overture-buildings", "overture-building-parts"] : ["chmv2-height", "chmv2-validity-mask", "osm-tree-fallback"];
