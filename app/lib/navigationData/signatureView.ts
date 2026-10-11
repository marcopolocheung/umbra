/**
 * The client's read side of the shade signatures (#321).
 *
 * A signature is a lossy 16-number summary of one sidewalk side's year of
 * shade, plus a coarse type from a frozen model. It answers "which loaded
 * sides have a year of shade like this one" and "which type is this side",
 * never "how shaded is this route": routing reads the exact shade table.
 *
 * A `SignatureView` is built from the cells a caller loaded (index + payload +
 * the cell's shade index, whose `segments` give the row order). Nearest
 * neighbours are brute force over those rows: cheap at this size, and exact
 * in signature space.
 *
 * Pure and synchronous once built; the fetching lives in `remoteNavigation`.
 */

import { shadeSegmentKey } from "./shadeSlots";
import {
  SIGNATURE_BYTES_PER_SIDE,
  SIGNATURE_COMPONENTS,
  type NavigationShadeShard,
  type NavigationSignatureIndex,
  type NavigationSignatureType,
} from "./shardContract";

/** 0 = left, 1 = right, matching the shade table's byte pair. */
export type SignatureSide = 0 | 1;

export interface SignatureCell {
  /** The cell's shade index: its `segments` are the payload's row order. */
  shard: NavigationShadeShard;
  /** The verified `signatures/<cell>.bin` bytes. */
  payload: Uint8Array;
}

export interface SignatureNeighbour {
  /** Canonical segment key, `shadeSegmentKey(lo, hi)`. */
  key: string;
  side: SignatureSide;
  /** Euclidean distance in signature space. */
  distance: number;
}

export interface SignatureView {
  /** Sides held. */
  readonly size: number;
  /** The side's frozen type id, or null when the side is not held. */
  typeOf(key: string, side: SignatureSide): number | null;
  /** A type's frozen name and hours. */
  type(id: number): NavigationSignatureType | undefined;
  /** The `k` nearest held sides to a held side, closest first, excluding itself. */
  nearest(key: string, side: SignatureSide, k: number): SignatureNeighbour[] | null;
}

export function createSignatureView(
  index: NavigationSignatureIndex,
  cells: ReadonlyArray<SignatureCell>,
): SignatureView {
  const { scales, types } = index.model;
  let rows = 0;
  for (const { shard, payload } of cells) {
    if (payload.byteLength !== shard.segments.length * 2 * SIGNATURE_BYTES_PER_SIDE)
      throw new Error("signature payload does not match its shade index");
    rows += shard.segments.length * 2;
  }

  // Dequantized once: int8 × scale, one row of SIGNATURE_COMPONENTS per side.
  const vectors = new Float32Array(rows * SIGNATURE_COMPONENTS);
  const typeIds = new Uint8Array(rows);
  const sides = new Uint8Array(rows);
  const keys: string[] = new Array(rows);
  const rowOf = new Map<string, number>();
  let row = 0;
  for (const { shard, payload } of cells) {
    for (let segment = 0; segment < shard.segments.length; segment++) {
      const [lo, hi] = shard.segments[segment];
      const key = shadeSegmentKey(lo, hi);
      for (let side = 0; side < 2; side++, row++) {
        const source = (segment * 2 + side) * SIGNATURE_BYTES_PER_SIDE;
        const target = row * SIGNATURE_COMPONENTS;
        for (let c = 0; c < SIGNATURE_COMPONENTS; c++) {
          const byte = payload[source + c];
          vectors[target + c] = (byte > 127 ? byte - 256 : byte) * scales[c];
        }
        typeIds[row] = payload[source + SIGNATURE_COMPONENTS];
        sides[row] = side;
        keys[row] = key;
        if (rowOf.has(`${key}/${side}`))
          throw new Error(`signature segment ${key} appears in two cells`);
        rowOf.set(`${key}/${side}`, row);
      }
    }
  }

  return {
    size: rows,
    typeOf(key, side) {
      const found = rowOf.get(`${key}/${side}`);
      return found === undefined ? null : typeIds[found];
    },
    type(id) {
      return types[id];
    },
    nearest(key, side, k) {
      const query = rowOf.get(`${key}/${side}`);
      if (query === undefined) return null;
      const count = Math.max(0, Math.min(Math.floor(k), rows - 1));
      if (count === 0) return [];
      // Top-k by insertion into a sorted buffer: k is small, rows are many.
      const bestRows = new Int32Array(count);
      const bestDistances = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
      // The query copied out, and each row abandoned as soon as its partial
      // sum passes the current k-th best: most rows exit after a few terms.
      const q = vectors.slice(query * SIGNATURE_COMPONENTS, (query + 1) * SIGNATURE_COMPONENTS);
      for (let other = 0; other < rows; other++) {
        if (other === query) continue;
        const o = other * SIGNATURE_COMPONENTS;
        const worst = bestDistances[count - 1];
        let distance = 0;
        for (let c = 0; c < SIGNATURE_COMPONENTS && distance < worst; c++) {
          const d = vectors[o + c] - q[c];
          distance += d * d;
        }
        if (distance >= worst) continue;
        let slot = count - 1;
        while (slot > 0 && bestDistances[slot - 1] > distance) {
          bestDistances[slot] = bestDistances[slot - 1];
          bestRows[slot] = bestRows[slot - 1];
          slot--;
        }
        bestDistances[slot] = distance;
        bestRows[slot] = other;
      }
      const out: SignatureNeighbour[] = [];
      for (let i = 0; i < count; i++) {
        const found = bestRows[i];
        out.push({
          key: keys[found],
          side: sides[found] as SignatureSide,
          distance: Math.sqrt(bestDistances[i]),
        });
      }
      return out;
    },
  };
}
