import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NavigationBuildingStatus } from "../../../app/lib/navigationData/shardContract";
import { canonicalJson } from "./canonical";
import { histogram, median, type Histogram } from "./stats";

/**
 * NYC Building Footprints → normalized caster records.
 *
 * Feature/status policy (documented in the highlight and the architecture
 * decision record, applied once and only here):
 *
 * - Placeholder triangles (1003) are rejected — no ground caster exists.
 * - Records whose last status type is Demolition or Marked For Demolition are
 *   rejected: there is no persistent ground shadow left to claim.
 * - Ground-shadow casters are included: Building (2100), Building Under
 *   Construction (5100), Garage (5110), Parking (1000), Gas Station Canopy
 *   (1001), Storage Tank (1002), Auxiliary Structure (1004), Temporary
 *   Structure (1005), Cantilevered Building (1006), Skybridge (2110).
 * - Published status: 5100 → "under-construction"; non-building casters
 *   (1000, 1001, 1002, 1004, 1005, 1006, 2110) → "other"; else "active".
 * - Height: HEIGHT_ROOF is feet above ground. Metres are computed here, once.
 *   Zero/null/negative/implausible (> 3000 ft) is unknown, never zero. A
 *   building with an unknown height takes a typed fallback — the median known
 *   height of its feature code, falling back to the citywide median — and is
 *   published as `heightSource: "fallback"`. `unknown` remains only when no
 *   known height exists to derive a fallback from, which is why it must stay
 *   observable (per-shard `missingHeights`).
 * - Angry rings are repaired (duplicate points dropped, ring closed) and
 *   reported; rings that stay degenerate, self-intersect, or lost their area
 *   are rejected and reported. Every ring publishes as its own prism, which is
 *   the current shadow-model treatment for holes and multiparts.
 */

export type StatusCategory = NavigationBuildingStatus;

export interface NormalizedBuilding {
  doittId: number;
  featureCode: number;
  status: StatusCategory;
  /** Source field, retained for preparation evidence only. */
  statusType: string;
  /** Source last-edited epoch ms, retained for preparation evidence only. */
  lastEdited: number | null;
  /** Raw source feet, retained for preparation evidence only. */
  heightFt: number | null;
  heightM: number | null;
  heightSource: "source" | "fallback" | "unknown";
  /** Closed rings, [lng, lat] pairs at 1e-7 degrees. */
  rings: Array<Array<[number, number]>>;
}

const INCLUDED_FEATURE_CODES = new Set<number>([
  1000, 1001, 1002, 1004, 1005, 1006, 2100, 2110, 5100, 5110,
]);

const REJECTED_STATUS_TYPES = new Set(["Demolition", "Marked For Demolition"]);

/** Non-building ground casters get the honest "other" status. */
const OTHER_CODES = new Set<number>([1000, 1001, 1002, 1004, 1005, 1006, 2110]);

const FEET_TO_METRES = 0.3048;
/** Above this, a HEIGHT_ROOF figure is assumed garbage, not a building. */
const IMPLAUSIBLE_HEIGHT_FT = 3_000;

export interface BuildingStats {
  byFeatureCode: Histogram;
  byStatusType: Histogram;
  byPublishedStatus: Histogram;
  known: number;
  fallback: number;
  unknown: number;
  repairedRings: number;
  rejected: { reason: string; count: number }[];
  heightPercentilesFt: Record<string, number>;
  maxHeightM: number;
}

export interface BuildingsResult {
  buildings: NormalizedBuilding[];
  stats: BuildingStats;
}

interface RawPage {
  features?: Array<{
    attributes?: Record<string, unknown>;
    geometry?: { rings?: unknown };
  }>;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePage(text: string): RawPage {
  return JSON.parse(text) as RawPage;
}

function dedupeAndClose(points: Array<[number, number]>): Array<[number, number]> {
  const clean: Array<[number, number]> = [];
  for (const point of points) {
    const last = clean[clean.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-9 && Math.abs(last[1] - point[1]) < 1e-9)
      continue;
    clean.push(point);
  }
  if (clean.length >= 3) {
    const first = clean[0];
    const last = clean[clean.length - 1];
    if (Math.abs(first[0] - last[0]) >= 1e-9 || Math.abs(first[1] - last[1]) >= 1e-9)
      clean.push([first[0], first[1]]);
  }
  return clean;
}

function ringArea(ring: Array<[number, number]>): number {
  // Shoelace in local plane: degrees² times the square metres per degree at
  // the ring's own latitude, so the threshold below is a real floor area.
  let sy = 0;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sy += ring[i][1];
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  const midLat = (sy / (ring.length - 1)) * (Math.PI / 180);
  const mPerLng = 111_320 * Math.max(Math.cos(midLat), 0.05);
  return (Math.abs(sum) / 2) * 111_320 * mPerLng;
}

function onSegment(a: [number, number], b: [number, number], p: [number, number]): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-12 <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    Math.min(a[1], b[1]) - 1e-12 <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + 1e-12
  );
}

function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : -1;
}

function segmentsIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

function ringSelfIntersects(ring: Array<[number, number]>): boolean {
  for (let i = 0; i < ring.length - 1; i += 1) {
    for (let j = i + 1; j < ring.length - 1; j += 1) {
      if (j === i + 1 || (i === 0 && j === ring.length - 2)) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

/** Returns a closed ring or null (reject reason "invalid-ring"). */
function repairRing(
  raw: Array<[number, number]>,
  repairedFlag: { value: boolean },
): Array<[number, number]> | null {
  const finite = raw.filter(
    (point) =>
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]) &&
      point[0] >= -180 &&
      point[0] <= 180 &&
      point[1] >= -90 &&
      point[1] <= 90,
  );
  const ring = dedupeAndClose(finite.map(([lng, lat]) => [lng, lat] as [number, number]));
  repairedFlag.value = repairedFlag.value || ring.length !== raw.length;
  if (ring.length < 4) return null;
  // Below this floor the trait is a degenerate sliver, not a ground caster.
  if (ringArea(ring) < 1) return null;
  if (ringSelfIntersects(ring)) return null;
  return ring.map(
    ([lng, lat]) => [Number(lng.toFixed(7)), Number(lat.toFixed(7))] as [number, number],
  );
}

function deservesOther(featureCode: number): boolean {
  return OTHER_CODES.has(featureCode);
}

export function statusFor(featureCode: number): StatusCategory | null {
  if (featureCode === 5100) return "under-construction";
  if (featureCode === 2100 || featureCode === 5110) return "active";
  if (deservesOther(featureCode)) return "other";
  return null;
}

export type RejectKey =
  | "no-doitt-id"
  | "placeholder"
  | "demolished"
  | "unknown-feature-code"
  | "no-geometry"
  | "invalid-rings"
  | "under-construction-without-height"
  | "duplicate-doitt-id";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Normalizes every building page in one pass. */
export function normalizeBuildings(pages: string[]): BuildingsResult {
  const buildings: NormalizedBuilding[] = [];
  const rejected = new Map<RejectKey, number>();
  const bump = (key: RejectKey) => rejected.set(key, (rejected.get(key) ?? 0) + 1);

  const knownByFeature = new Map<number, number[]>();
  let repairedRings = 0;

  for (const text of pages) {
    const page = parsePage(text);
    for (const feature of page.features ?? []) {
      const attributes = feature.attributes ?? {};
      const doittId = num(attributes.DOITT_ID);
      const featureCode = num(attributes.FEATURE_CODE);
      const statusType =
        typeof attributes.LAST_STATUS_TYPE === "string"
          ? (attributes.LAST_STATUS_TYPE as string)
          : "";
      const lastEdited = num(attributes.LAST_EDITED_DATE);
      const heightFt = num(attributes.HEIGHT_ROOF);

      if (doittId === null) {
        bump("no-doitt-id");
        continue;
      }
      if (REJECTED_STATUS_TYPES.has(statusType)) {
        bump("demolished");
        continue;
      }
      if (featureCode === 1003) {
        bump("placeholder");
        continue;
      }
      if (featureCode === null || !INCLUDED_FEATURE_CODES.has(featureCode)) {
        bump("unknown-feature-code");
        continue;
      }
      const status = statusFor(featureCode)!;
      const geometry = feature.geometry as { rings?: unknown } | undefined;
      const rawRings = Array.isArray(geometry?.rings) ? (geometry!.rings as unknown[][]) : [];
      if (rawRings.length === 0) {
        bump("no-geometry");
        continue;
      }
      const rings: Array<Array<[number, number]>> = [];
      const repairedFlag = { value: false };
      for (const raw of rawRings) {
        const points = Array.isArray(raw)
          ? (raw as unknown[]).map((point) =>
              Array.isArray(point) && num(point[0]) !== null && num(point[1]) !== null
                ? ([num(point[0])!, num(point[1])!] as [number, number])
                : ([Number.NaN, Number.NaN] as [number, number]),
            )
          : [];
        const ring = repairRing(points, repairedFlag);
        if (!ring) continue;
        rings.push(ring);
      }
      if (rings.length === 0) {
        bump("invalid-rings");
        continue;
      }
      if (repairedFlag.value) repairedRings += 1;

      const usableHeightFt =
        heightFt !== null && heightFt > 0 && heightFt < IMPLAUSIBLE_HEIGHT_FT ? heightFt : null;
      if (usableHeightFt !== null) {
        const known = knownByFeature.get(featureCode) ?? [];
        known.push(round2(usableHeightFt * FEET_TO_METRES));
        knownByFeature.set(featureCode, known);
      }

      buildings.push({
        doittId,
        featureCode,
        status,
        statusType,
        lastEdited,
        heightFt,
        heightM: usableHeightFt !== null ? round2(usableHeightFt * FEET_TO_METRES) : null,
        heightSource: usableHeightFt !== null ? "source" : "unknown",
        rings,
      });
    }
  }

  // Typed fallback: median known height per feature code, then citywide median.
  const allKnown = [...knownByFeature.values()].flat();
  const sortedAll = allKnown.sort((a, b) => a - b);
  const globalMedian = median(sortedAll);
  const fallbackFor = new Map<number, number | null>();
  for (const code of INCLUDED_FEATURE_CODES) {
    const known = [...(knownByFeature.get(code) ?? [])].sort((a, b) => a - b);
    fallbackFor.set(code, Number.isFinite(median(known)) ? round2(median(known)) : null);
  }
  for (const building of buildings) {
    if (building.heightSource === "source") continue;
    const typed = fallbackFor.get(building.featureCode);
    const fallback = typed ?? (Number.isFinite(globalMedian) ? globalMedian : null);
    if (fallback !== null) {
      building.heightM = fallback;
      building.heightSource = "fallback";
    } else if (building.status === "under-construction") {
      bump("under-construction-without-height");
      building.heightM = 0;
    }
  }
  const withHeight = buildings.filter(
    (building) => building.heightM !== null || building.status !== "under-construction",
  );
  const withoutHeightUnderConstruction = buildings.filter(
    (building) => building.status === "under-construction" && building.heightM === 0,
  );
  const survivors = withHeight.filter(
    (building) => !withoutHeightUnderConstruction.includes(building),
  );

  // Stable identity: one record per DOITT_ID, first by id order.
  survivors.sort((a, b) => a.doittId - b.doittId);
  const deduped: NormalizedBuilding[] = [];
  let previous = -1;
  for (const building of survivors) {
    if (building.doittId === previous) {
      bump("duplicate-doitt-id");
      continue;
    }
    previous = building.doittId;
    deduped.push(building);
  }

  const falls = deduped.filter((building) => building.heightSource === "fallback").length;
  const stats: BuildingStats = {
    byFeatureCode: histogram(deduped, (building) => String(building.featureCode)),
    byStatusType: histogram(deduped, (building) => building.statusType || "(missing)"),
    byPublishedStatus: histogram(deduped, (building) => building.status),
    known: deduped.reduce((sum, building) => sum + (building.heightSource === "source" ? 1 : 0), 0),
    fallback: falls,
    unknown: deduped.reduce(
      (sum, building) => sum + (building.heightSource === "unknown" ? 1 : 0),
      0,
    ),
    repairedRings,
    rejected: [...rejected.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => (a.reason < b.reason ? -1 : 1)),
    heightPercentilesFt: (() => {
      const values = deduped
        .filter((building) => building.heightFt !== null && building.heightFt! > 0)
        .map((building) => building.heightFt!)
        .sort((a, b) => a - b);
      return {
        p50: values[Math.floor(values.length * 0.5)] ?? Number.NaN,
        p90: values[Math.floor(values.length * 0.9)] ?? Number.NaN,
        p99: values[Math.floor(values.length * 0.99)] ?? Number.NaN,
        max: values[values.length - 1] ?? Number.NaN,
      };
    })(),
    maxHeightM: deduped.reduce((max, building) => Math.max(max, building.heightM ?? 0), 0),
  };
  return { buildings: deduped, stats };
}

/** Reads all pages of the acquired release from disk, in order. */
export async function readBuildingPages(pagesDirectory: string, count: number): Promise<string[]> {
  const pages: string[] = [];
  for (let index = 0; index < count; index += 1) {
    pages.push(
      await readFile(join(pagesDirectory, `${String(index).padStart(5, "0")}.json`), "utf8"),
    );
  }
  return pages;
}

/** Serializes normalized records as one canonical JSON object per line. */
export function buildingsToNdjson(buildings: NormalizedBuilding[]): string {
  return `${buildings.map((building) => canonicalJson(building)).join("\n")}\n`;
}

export function buildingsFromNdjson(text: string): NormalizedBuilding[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NormalizedBuilding);
}
