/** Strict, deterministic OGC WKB reader.  GeoParquet geometry is never handed to
 * a GIS library with implicit repair rules: rings and holes survive byte-for-byte
 * (apart from the normal JavaScript number representation). */
export type Position = readonly [number, number];
export interface WkbPolygon { outer: Position[]; holes: Position[][]; }
export interface WkbGeometry { type: "Polygon" | "MultiPolygon"; polygons: WkbPolygon[]; }

class Cursor {
  constructor(readonly bytes: Uint8Array, private offset = 0) {}
  private require(size: number): void { if (this.offset + size > this.bytes.byteLength) throw new Error("truncated WKB geometry"); }
  u8(): number { this.require(1); return this.bytes[this.offset++]; }
  u32(little: boolean): number { this.require(4); const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(0, little); this.offset += 4; return value; }
  f64(little: boolean): number { this.require(8); const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getFloat64(0, little); this.offset += 8; if (!Number.isFinite(value)) throw new Error("non-finite WKB coordinate"); return value; }
  done(): boolean { return this.offset === this.bytes.byteLength; }
}
function geometry(cursor: Cursor): WkbGeometry {
  const order = cursor.u8(); if (order !== 0 && order !== 1) throw new Error("invalid WKB byte order");
  const little = order === 1; const rawType = cursor.u32(little); const hasZ = (rawType & 0x80000000) !== 0 || rawType >= 1000;
  const hasM = (rawType & 0x40000000) !== 0 || (rawType >= 2000 && rawType < 3000);
  const type = rawType & 0x0fffffff; const base = type >= 3000 ? type - 3000 : type >= 2000 ? type - 2000 : type >= 1000 ? type - 1000 : type;
  const point = (): Position => { const x = cursor.f64(little), y = cursor.f64(little); if (hasZ) cursor.f64(little); if (hasM) cursor.f64(little); return [x, y]; };
  const ring = (): Position[] => { const count = cursor.u32(little); if (count < 4) throw new Error("WKB polygon ring has fewer than four points"); const value = Array.from({ length: count }, point); const a = value[0], b = value.at(-1)!; if (a[0] !== b[0] || a[1] !== b[1]) throw new Error("WKB polygon ring is not closed"); return value; };
  if (base === 3) { const count = cursor.u32(little); if (!count) throw new Error("WKB polygon has no exterior ring"); return { type: "Polygon", polygons: [{ outer: ring(), holes: Array.from({ length: count - 1 }, ring) }] }; }
  if (base === 6) { const count = cursor.u32(little); const polygons: WkbPolygon[] = []; for (let index = 0; index < count; index++) { const child = geometry(cursor); if (child.type !== "Polygon" || child.polygons.length !== 1) throw new Error("WKB multipolygon contains a non-polygon"); polygons.push(child.polygons[0]); } return { type: "MultiPolygon", polygons }; }
  throw new Error(`unsupported WKB geometry type ${rawType}`);
}
export function decodeWkb(value: Uint8Array | Buffer): WkbGeometry {
  const result = geometry(new Cursor(value));
  // A geometry value has exactly one root object. Trailing bytes normally mean a
  // different binary column was accidentally accepted as WKB.
  const cursor = new Cursor(value); geometry(cursor); if (!cursor.done()) throw new Error("trailing bytes after WKB geometry");
  return result;
}
