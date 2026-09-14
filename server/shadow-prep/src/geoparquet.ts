import { DuckDBConnection } from "@duckdb/node-api";
import { decodeWkb, type WkbGeometry } from "./wkb";

/** The Overture release uses `id`, not the old `record_id` convenience name.
 * Keep this deliberately narrow: accepting an alias would turn a schema change
 * into silently different building identity semantics. */
export interface GeoParquetRow { id: string; geometry: WkbGeometry; height: number; minHeight: number; buildingId?: string; }
export type GeoParquetKind = "buildings" | "parts";
export interface GeoParquetBounds { west: number; south: number; east: number; north: number; }
const required = (kind: GeoParquetKind) => kind === "parts" ? ["id", "geometry", "height", "min_height", "building_id"] : ["id", "geometry", "height", "min_height"];
const quote = (path: string) => `'${path.replaceAll("'", "''")}'`;

/** Schema is checked before any row can influence a candidate.  This is purposefully
 * narrow: a renamed/missing field is a release drift, not a value to guess at. */
export async function validateGeoParquetSchema(path: string, kind: GeoParquetKind): Promise<void> {
  const connection = await DuckDBConnection.create();
  try {
    const rows = await (await connection.run(`DESCRIBE SELECT * FROM read_parquet(${quote(path)})`)).getRowObjectsJS() as Array<Record<string, unknown>>;
    const columns = new Map(rows.map((row) => [String(row.column_name).toLowerCase(), String(row.column_type).toUpperCase()]));
    for (const name of required(kind)) if (!columns.has(name)) throw new Error(`GeoParquet schema drift: ${kind} lacks required ${name}`);
    const geometry = columns.get("geometry")!;
    // DuckDB exposes GeoParquet WKB as GEOMETRY when it recognizes the
    // extension metadata, and as BLOB otherwise. Both are still WKB bytes.
    if (!/(BLOB|BINARY|GEOMETRY)/.test(geometry)) throw new Error(`GeoParquet schema drift: geometry must be WKB BLOB/GEOMETRY, got ${geometry}`);
    for (const name of ["height", "min_height"]) if (!/(DOUBLE|FLOAT|DECIMAL|REAL|HUGEINT|BIGINT|INTEGER)/.test(columns.get(name)!)) throw new Error(`GeoParquet schema drift: ${name} is not numeric`);
    if (kind === "parts" && !/(VARCHAR|TEXT|STRING|UUID)/.test(columns.get("building_id")!)) throw new Error("GeoParquet schema drift: building_id is not a stable string");
  } finally { connection.closeSync(); }
}

/** DuckDB is the sole production GeoParquet reader (the pinned GDAL lacks Parquet).
 * SQL ordering makes the stream invariant to row-group and source-row ordering. */
export async function readGeoParquet(path: string, kind: GeoParquetKind): Promise<GeoParquetRow[]> {
  await validateGeoParquetSchema(path, kind);
  const connection = await DuckDBConnection.create();
  try {
    return await readRows(connection, path, kind);
  } finally { connection.closeSync(); }
}

async function readRows(connection: DuckDBConnection, path: string, kind: GeoParquetKind, where = ""): Promise<GeoParquetRow[]> {
  const fields = kind === "parts" ? "id, geometry, height, min_height, building_id" : "id, geometry, height, min_height";
  const result = await connection.stream(`SELECT ${fields} FROM read_parquet(${quote(path)})${where} ORDER BY id ASC`);
  const output: GeoParquetRow[] = [];
  for await (const rows of result.yieldRowObjectJs()) for (const row of rows) {
    const id = String(row.id ?? ""); const height = Number(row.height), minHeight = Number(row.min_height);
    if (!id || !Number.isFinite(height) || !Number.isFinite(minHeight)) throw new Error(`invalid GeoParquet ${kind} value for ${id || "unnamed record"}`);
    const binary = row.geometry; if (!(binary instanceof Uint8Array)) throw new Error(`GeoParquet ${kind} geometry is not WKB for ${id}`);
    const buildingId = kind === "parts" ? String(row.building_id ?? "") : undefined;
    if (kind === "parts" && !buildingId) throw new Error(`GeoParquet part lacks building_id: ${id}`);
    output.push({ id, geometry: decodeWkb(binary), height, minHeight, buildingId });
  }
  return output;
}

/** Read only the admitted features that can affect one z18 tile.  This avoids
 * materializing a multi-million-row regional extract in the Node heap. */
export async function readGeoParquetIntersecting(path: string, kind: GeoParquetKind, bounds: GeoParquetBounds): Promise<GeoParquetRow[]> {
  await validateGeoParquetSchema(path, kind);
  const connection = await DuckDBConnection.create();
  try {
    // GeoParquet geometry is already DuckDB GEOMETRY; no WKB conversion is
    // valid here. The spatial extension is baked into the preparation image.
    await connection.run("LOAD spatial;");
    const values = [bounds.west, bounds.south, bounds.east, bounds.north];
    if (!values.every(Number.isFinite) || bounds.west >= bounds.east || bounds.south >= bounds.north) throw new Error("invalid GeoParquet intersection bounds");
    return await readRows(connection, path, kind, ` WHERE ST_Intersects(geometry, ST_MakeEnvelope(${values.join(",")}))`);
  } finally { connection.closeSync(); }
}

/** Parent records are fetched by source identity when an intersecting part's
 * parent footprint lies outside the current tile envelope. */
export async function readGeoParquetByIds(path: string, ids: readonly string[]): Promise<GeoParquetRow[]> {
  if (!ids.length) return [];
  await validateGeoParquetSchema(path, "buildings");
  const connection = await DuckDBConnection.create();
  try {
    const unique = [...new Set(ids)].sort();
    return await readRows(connection, path, "buildings", ` WHERE id IN (${unique.map((id) => quote(id)).join(",")})`);
  } finally { connection.closeSync(); }
}
