import { DuckDBConnection } from "@duckdb/node-api";
import { decodeWkb, type WkbGeometry } from "./wkb";

export interface GeoParquetRow { recordId: string; geometry: WkbGeometry; height: number; minHeight: number; buildingId?: string; }
export type GeoParquetKind = "buildings" | "parts";
const required = (kind: GeoParquetKind) => kind === "parts" ? ["record_id", "geometry", "height", "min_height", "building_id"] : ["record_id", "geometry", "height", "min_height"];
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
    if (!/(BLOB|BINARY)/.test(geometry)) throw new Error(`GeoParquet schema drift: geometry must be WKB BLOB, got ${geometry}`);
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
    const fields = kind === "parts" ? "record_id, geometry, height, min_height, building_id" : "record_id, geometry, height, min_height";
    const result = await connection.stream(`SELECT ${fields} FROM read_parquet(${quote(path)}) ORDER BY record_id ASC`);
    const output: GeoParquetRow[] = [];
    for await (const rows of result.yieldRowObjectJs()) for (const row of rows) {
      const recordId = String(row.record_id ?? ""); const height = Number(row.height), minHeight = Number(row.min_height);
      if (!recordId || !Number.isFinite(height) || !Number.isFinite(minHeight)) throw new Error(`invalid GeoParquet ${kind} value for ${recordId || "unnamed record"}`);
      const binary = row.geometry; if (!(binary instanceof Uint8Array)) throw new Error(`GeoParquet ${kind} geometry is not WKB for ${recordId}`);
      const buildingId = kind === "parts" ? String(row.building_id ?? "") : undefined;
      if (kind === "parts" && !buildingId) throw new Error(`GeoParquet part lacks building_id: ${recordId}`);
      output.push({ recordId, geometry: decodeWkb(binary), height, minHeight, buildingId });
    }
    return output;
  } finally { connection.closeSync(); }
}
