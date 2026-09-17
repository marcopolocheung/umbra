import { haversineMeters } from "./routing";
import type { OsmNode, GraphEdge, RoutingGraph } from "./routing";

// Requests go through a same-origin proxy, never directly to overpass-api.de:
// the public instance omits CORS headers on its 429/504 error responses, which
// browsers report as a (misleading) CORS failure. In dev we use Vite's proxy;
// in production a Vercel function at /api/overpass (which also handles the
// mirror fallback server-side). See vite.config.ts and api/overpass.js.
const OVERPASS_BASE = import.meta.env.DEV ? "/__overpass" : "/api/overpass";

const FETCH_TIMEOUT_MS = 30_000;

async function postOverpass(
  body: string,
  signal?: AbortSignal
): Promise<Response> {
  // No User-Agent header: it's a forbidden header in browsers (silently
  // dropped). The proxy sets a real one server-side.
  return fetch(OVERPASS_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal,
  });
}

// Simple LRU graph cache: reuse a previously fetched graph whose bounding box
// fully contains the new request. Avoids redundant Overpass fetches when the
// user nudges a waypoint slightly (the most common interaction pattern).
interface CacheEntry {
  south: number;
  west: number;
  north: number;
  east: number;
  graph: RoutingGraph;
}
export interface BboxBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}
const GRAPH_CACHE_MAX = 5;
const graphCache: CacheEntry[] = []; // newest first

function cacheContains(
  entry: BboxBounds,
  south: number,
  west: number,
  north: number,
  east: number
): boolean {
  return (
    entry.south <= south &&
    entry.west <= west &&
    entry.north >= north &&
    entry.east >= east
  );
}

function cloneRoutingGraph(graph: RoutingGraph): RoutingGraph {
  const nodes = new Map<number, OsmNode>();
  for (const [id, node] of graph.nodes) {
    nodes.set(id, { ...node });
  }

  const adj = new Map<number, GraphEdge[]>();
  for (const [id, edges] of graph.adj) {
    adj.set(id, edges.map((edge) => ({ ...edge })));
  }

  return { nodes, adj };
}

/**
 * Fetches OSM walkable road graph for the given bounding box via Overpass API.
 * All edge shadowFactor values are initialized to 0 — caller fills them in.
 * Results are cached by bbox; a cached graph is returned if it fully covers
 * the new request without re-fetching.
 */
/**
 * Prints why the upstream pool gave up, to the browser console.
 *
 * Deliberately not gated on DEV. "The map server is busy" is the same message
 * whether every mirror refused the request (rate limiting) or each one merely
 * ran past its budget (a query too slow) — and those have opposite fixes. The
 * proxy classifies it per attempt, but that only reached its own logs, which
 * expire; this is what makes a production failure diagnosable from the browser
 * that saw it. Never carries the query or any coordinate.
 */
async function reportUpstreamFailure(res: Response): Promise<void> {
  try {
    const detail = (await res.clone().json()) as {
      attempts?: { endpoint: string; failureClass: string; durationMs: number; status?: number }[];
    };
    if (!detail.attempts?.length) return;
    const summary = detail.attempts
      .map((a) => `${a.endpoint} ${a.failureClass}${a.status ? ` ${a.status}` : ""} ${a.durationMs}ms`)
      .join(" | ");
    console.warn(`[overpass] upstream unavailable (${res.status}): ${summary}`);
  } catch {
    // A body that is missing or unparseable tells us nothing; the thrown
    // message below is still the user-facing outcome either way.
  }
}

export async function fetchRoutingGraph(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal
): Promise<RoutingGraph> {
  // Return cached graph if a previously fetched bbox fully covers this request
  for (const entry of graphCache) {
    if (cacheContains(entry, south, west, north, east)) {
      return cloneRoutingGraph(entry.graph);
    }
  }

  const query = `
[out:json][timeout:25];
(
  way["highway"~"^(footway|path|pedestrian|living_street|residential|unclassified|tertiary|secondary|service|cycleway|steps|track|bridleway)$"]["area"!="yes"]
  (${south},${west},${north},${east});
);
out body geom;
`.trim();

  const encodedBody = `data=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;

  let res: Response;
  try {
    // The proxy handles the mirror fallback server-side.
    res = await postOverpass(encodedBody, combinedSignal);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      if (signal?.aborted) throw e; // caller-initiated abort: rethrow as AbortError
      throw new Error(
        "Route request timed out — try a shorter route or a less busy area."
      );
    }
    throw e;
  } finally {
    clearTimeout(tid);
  }

  if (!res.ok) {
    if ([429, 502, 503, 504].includes(res.status)) {
      await reportUpstreamFailure(res);
      throw new Error(
        "The map server is busy — try a smaller area or wait a moment and retry."
      );
    }
    throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error(
      "The map server returned an error — the area may be too complex. Try repositioning your waypoints."
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = JSON.parse(text) as { elements?: any[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: any[] = json.elements ?? [];

  // out body geom returns only way elements — geometry is inline as way.geometry[i].{lat,lon}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawWays = elements.filter((e: any) => e.type === "way");

  if (rawWays.length === 0) {
    throw new Error(
      "No walkable roads found in this area. Try a more urban location or zoom closer."
    );
  }

  const graph = buildRoutingGraphFromElements(rawWays);
  return cacheFetchedGraph(south, west, north, east, graph);
}
/**
 * One Overpass `way` element with inline geometry (`out body geom`), as far
 * as the routing graph cares. Structural so fixtures can hand-trimmed JSON.
 */
export interface OverpassWayElement {
  type?: string;
  id?: number;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string | undefined>;
}

/**
 * Pure Overpass-ways → routing-graph builder (no fetch, no cache). Split out
 * of `fetchRoutingGraph` so hermetic tests can load a committed Madrid-centre
 * fixture through the exact production code path (E4).
 */
export function buildRoutingGraphFromElements(rawWays: OverpassWayElement[]): RoutingGraph {
  // Count distinct ways each node appears in — marks intersections
  const nodeWayCount = new Map<number, number>();
  for (const way of rawWays) {
    const seen = new Set<number>();
    for (const nid of way.nodes ?? []) {
      if (!seen.has(nid)) {
        seen.add(nid);
        nodeWayCount.set(nid, (nodeWayCount.get(nid) ?? 0) + 1);
      }
    }
  }

  // Build node map and adjacency list from inline geometry
  const nodes = new Map<number, OsmNode>();
  const adj = new Map<number, GraphEdge[]>();

  const ensureAdj = (id: number) => {
    if (!adj.has(id)) adj.set(id, []);
  };

  for (const way of rawWays) {
    const nodeRefs: number[] = way.nodes ?? [];
    const geom: Array<{ lat: number; lon: number }> = way.geometry ?? [];

    // Skip closed highway=pedestrian ways — these are plaza/square area polygons,
    // not walkable paths. Their ring geometry would otherwise add spurious edges.
    const isClosed =
      nodeRefs.length >= 2 &&
      nodeRefs[0] === nodeRefs[nodeRefs.length - 1];
    if (isClosed && way.tags?.highway === "pedestrian") continue;

    // Register nodes from inline geometry
    for (let i = 0; i < nodeRefs.length; i++) {
      const nid = nodeRefs[i];
      if (!nodes.has(nid) && geom[i]) {
        nodes.set(nid, {
          id: nid,
          lat: geom[i].lat,
          lon: geom[i].lon,
          isIntersection: (nodeWayCount.get(nid) ?? 0) >= 2,
        });
      }
    }

    for (let i = 0; i < nodeRefs.length - 1; i++) {
      const fromId = nodeRefs[i];
      const toId = nodeRefs[i + 1];
      const fromNode = nodes.get(fromId);
      const toNode = nodes.get(toId);
      if (!fromNode || !toNode) continue;

      const distanceM = haversineMeters(
        [fromNode.lon, fromNode.lat],
        [toNode.lon, toNode.lat]
      );

      ensureAdj(fromId);
      ensureAdj(toId);

      const edgeTags = {
        highway: way.tags?.highway,
        surface: way.tags?.surface,
        smoothness: way.tags?.smoothness,
        cycleway: way.tags?.cycleway,
        bicycle: way.tags?.bicycle,
        foot: way.tags?.foot,
        access: way.tags?.access,
      };

      adj.get(fromId)!.push({ toId, distanceM, shadowFactor: 0, ...edgeTags });
      adj.get(toId)!.push({ toId: fromId, distanceM, shadowFactor: 0, ...edgeTags });
    }
  }

  return { nodes, adj };
}

function cacheFetchedGraph(
  south: number,
  west: number,
  north: number,
  east: number,
  graph: RoutingGraph,
): RoutingGraph {
  // Cache newest-first; evict oldest when full
  graphCache.unshift({ south, west, north, east, graph });
  if (graphCache.length > GRAPH_CACHE_MAX) graphCache.pop();

  return cloneRoutingGraph(graph);
}

// ---------------------------------------------------------------------------
// Station entrance nodes (for MRT routing)
// ---------------------------------------------------------------------------

export interface StationEntranceNode {
  id: number;
  lat: number;
  lon: number;
  name?: string;
  /** "entrance" for railway=subway_entrance, "station" for railway=station */
  kind: "entrance" | "station";
}

interface StationEntranceCacheEntry extends BboxBounds {
  entrances: StationEntranceNode[];
}

const STATION_ENTRANCE_CACHE_MAX = 8;
const stationEntranceCache: StationEntranceCacheEntry[] = [];

function cloneStationEntrances(entrances: StationEntranceNode[]): StationEntranceNode[] {
  return entrances.map((entrance) => ({ ...entrance }));
}

export interface BuildingFootprint {
  id: number;
  heightM: number;
  rings: [number, number][][];
}

interface BuildingCacheEntry extends BboxBounds {
  buildings: BuildingFootprint[];
}

const BUILDING_CACHE_MAX = 8;
const buildingCache: BuildingCacheEntry[] = [];

function cloneBuildingFootprints(buildings: BuildingFootprint[]): BuildingFootprint[] {
  return buildings.map((building) => ({
    ...building,
    rings: building.rings.map((ring) =>
      ring.map(([lng, lat]) => [lng, lat] as [number, number])
    ),
  }));
}

function heightMForBuilding(tags: Record<string, unknown> | null | undefined): number {
  const renderHeight = Number(tags?.render_height);
  if (Number.isFinite(renderHeight) && renderHeight > 0) return renderHeight;
  const height = Number(tags?.height);
  if (Number.isFinite(height) && height > 0) return height;
  const levels = Number(tags?.["building:levels"]);
  if (Number.isFinite(levels) && levels > 0) return levels * 3;
  return 10;
}

function bboxAround(lng: number, lat: number, radiusM: number): {
  south: number;
  west: number;
  north: number;
  east: number;
} {
  const dLat = radiusM / 111320;
  const dLng = radiusM / Math.max(1e-6, 111320 * Math.cos(lat * Math.PI / 180));
  return {
    south: lat - dLat,
    west: lng - dLng,
    north: lat + dLat,
    east: lng + dLng,
  };
}

type LngLat = [number, number];

function coordsFromGeometry(geometry: Array<{ lat: number; lon: number }> | undefined): LngLat[] {
  return (geometry ?? []).map((p) => [p.lon, p.lat] as LngLat);
}

function samePoint(a: LngLat, b: LngLat): boolean {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
}

function isClosedRing(ring: LngLat[]): boolean {
  return ring.length >= 4 && samePoint(ring[0], ring[ring.length - 1]);
}

function closeRing(ring: LngLat[]): LngLat[] {
  if (ring.length === 0 || isClosedRing(ring)) return ring;
  return [...ring, ring[0]];
}

function assembleClosedRings(lines: LngLat[][]): LngLat[][] {
  const remaining = lines
    .map((line) => line.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
    .filter((line) => line.length >= 2);
  const rings: LngLat[][] = [];

  while (remaining.length > 0) {
    let ring = remaining.shift()!;
    let changed = true;

    while (!isClosedRing(ring) && changed) {
      changed = false;
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const start = ring[0];
        const end = ring[ring.length - 1];
        const cStart = candidate[0];
        const cEnd = candidate[candidate.length - 1];

        if (samePoint(end, cStart)) {
          ring = [...ring, ...candidate.slice(1)];
        } else if (samePoint(end, cEnd)) {
          ring = [...ring, ...candidate.slice(0, -1).reverse()];
        } else if (samePoint(start, cEnd)) {
          ring = [...candidate.slice(0, -1), ...ring];
        } else if (samePoint(start, cStart)) {
          ring = [...candidate.slice(1).reverse(), ...ring];
        } else {
          continue;
        }

        remaining.splice(i, 1);
        changed = true;
        break;
      }
    }

    if (ring.length >= 3) {
      const closed = closeRing(ring);
      if (isClosedRing(closed)) rings.push(closed);
    }
  }

  return rings;
}

/**
 * Fetch building footprints near a point for offscreen shadow checks.
 */
export async function fetchBuildingFootprintsAround(
  lng: number,
  lat: number,
  radiusM = 180,
  signal?: AbortSignal
): Promise<BuildingFootprint[]> {
  const { south, west, north, east } = bboxAround(lng, lat, radiusM);

  for (const entry of buildingCache) {
    if (cacheContains(entry, south, west, north, east)) {
      return cloneBuildingFootprints(entry.buildings);
    }
  }

  const query = `
[out:json][timeout:10];
(
  way["building"](${south},${west},${north},${east});
  relation["building"]["type"="multipolygon"](${south},${west},${north},${east});
);
out body geom;
`.trim();

  const encodedBody = `data=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 12_000);
  const combinedSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;

  let res: Response;
  try {
    res = await postOverpass(encodedBody, combinedSignal);
  } finally {
    clearTimeout(tid);
  }

  if (!res.ok) {
    throw new Error(`Overpass building API error: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("The map server returned an error while checking building shadow.");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = JSON.parse(text) as { elements?: any[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: any[] = json.elements ?? [];

  const wayBuildings = elements
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((e: any) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 3)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((e: any): BuildingFootprint => ({
      id: e.id,
      heightM: heightMForBuilding(e.tags),
      rings: [closeRing(coordsFromGeometry(e.geometry))],
    }));

  const relationBuildings = elements
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((e: any) => e.type === "relation" && Array.isArray(e.members))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((e: any): BuildingFootprint | null => {
      const outerLines = (e.members ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((m: any) => m.type === "way" && (m.role === "outer" || m.role == null || m.role === "") && Array.isArray(m.geometry))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((m: any) => coordsFromGeometry(m.geometry));
      const rings = assembleClosedRings(outerLines);
      if (rings.length === 0) return null;
      return {
        id: e.id,
        heightM: heightMForBuilding(e.tags),
        rings,
      };
    })
    .filter((b): b is BuildingFootprint => b !== null);

  const buildings = [...wayBuildings, ...relationBuildings];
  buildingCache.unshift({ south, west, north, east, buildings });
  if (buildingCache.length > BUILDING_CACHE_MAX) buildingCache.pop();

  return cloneBuildingFootprints(buildings);
}

// ---------------------------------------------------------------------------
// Canopy (Track A, checkpoint A7)
// ---------------------------------------------------------------------------

/**
 * The OSM tags the crown model reads, exactly as OSM spells them.
 *
 * Left as raw strings on purpose: this module fetches, `shadowField/canopy.ts`
 * models. Height for a *building* is resolved here because both shadow paths have
 * always consumed `BuildingFootprint.heightM`, but a crown needs a radius, a trunk
 * height and a leaf cycle as well, and the defaults that fill in for the ones OSM
 * almost never carries are a modelling decision that belongs next to its citation.
 */
export interface CanopyTags {
  height?: string;
  /** Crown *diameter* in metres — OSM's spelling. Tagged on well under 1% of trees. */
  diameter_crown?: string;
  leaf_type?: string;
  leaf_cycle?: string;
}

export interface CanopyFeature {
  id: number;
  /** A single tree, a line of them, or a block of woodland. */
  kind: "tree" | "tree_row" | "wood";
  /** `tree`: one point. `tree_row`: the centreline. `wood`: one closed ring. */
  points: [number, number][];
  tags: CanopyTags;
}

interface CanopyCacheEntry extends BboxBounds {
  canopy: CanopyFeature[];
}

const CANOPY_CACHE_MAX = 8;
const canopyCache: CanopyCacheEntry[] = [];

function cloneCanopy(features: CanopyFeature[]): CanopyFeature[] {
  return features.map((feature) => ({
    ...feature,
    points: feature.points.map(([lng, lat]) => [lng, lat] as [number, number]),
    tags: { ...feature.tags },
  }));
}

function canopyTags(tags: Record<string, unknown> | null | undefined): CanopyTags {
  const read = (key: string): string | undefined => {
    const value = tags?.[key];
    return typeof value === "string" ? value : undefined;
  };
  return {
    height: read("height"),
    diameter_crown: read("diameter_crown"),
    leaf_type: read("leaf_type"),
    leaf_cycle: read("leaf_cycle"),
  };
}

/**
 * Fetch tagged canopy near a point — individual trees, tree rows and woodland.
 *
 * A second Overpass call beside `fetchBuildingFootprintsAround`, against the same
 * shared public service, so it is only ever issued from a provider's `load()` over a
 * bbox the routing graph already needed. Woodland arrives as ways only: a forest
 * mapped as a multipolygon relation is skipped rather than half-assembled, and
 * `assembleClosedRings` is not reused here because a partly-assembled canopy ring
 * reports shadow in the wrong place with no way for a caller to tell.
 */
export async function fetchCanopyAround(
  lng: number,
  lat: number,
  radiusM = 180,
  signal?: AbortSignal
): Promise<CanopyFeature[]> {
  const { south, west, north, east } = bboxAround(lng, lat, radiusM);

  for (const entry of canopyCache) {
    if (cacheContains(entry, south, west, north, east)) {
      return cloneCanopy(entry.canopy);
    }
  }

  const query = `
[out:json][timeout:15];
(
  node["natural"="tree"](${south},${west},${north},${east});
  way["natural"="tree_row"](${south},${west},${north},${east});
  way["natural"="wood"](${south},${west},${north},${east});
  way["landuse"="forest"](${south},${west},${north},${east});
);
out body geom;
`.trim();

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 18_000);
  const combinedSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;

  let res: Response;
  try {
    res = await postOverpass(`data=${encodeURIComponent(query)}`, combinedSignal);
  } finally {
    clearTimeout(tid);
  }

  if (!res.ok) {
    throw new Error(`Overpass canopy API error: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("The map server returned an error while fetching tree canopy.");
  }

  const json = JSON.parse(text) as { elements?: any[] };
  const elements: any[] = json.elements ?? [];

  const canopy: CanopyFeature[] = [];
  for (const el of elements) {
    if (el.type === "node" && el.lat != null && el.lon != null) {
      canopy.push({
        id: el.id,
        kind: "tree",
        points: [[el.lon, el.lat]],
        tags: canopyTags(el.tags),
      });
      continue;
    }
    if (el.type !== "way" || !Array.isArray(el.geometry)) continue;

    const points = coordsFromGeometry(el.geometry).filter(
      (p) => Number.isFinite(p[0]) && Number.isFinite(p[1])
    );
    if (el.tags?.natural === "tree_row") {
      if (points.length >= 2) {
        canopy.push({ id: el.id, kind: "tree_row", points, tags: canopyTags(el.tags) });
      }
      continue;
    }
    // Woodland: a closed way only. An open one is a mapping error or half a relation.
    const ring = closeRing(points);
    if (isClosedRing(ring)) {
      canopy.push({ id: el.id, kind: "wood", points: ring, tags: canopyTags(el.tags) });
    }
  }

  canopyCache.unshift({ south, west, north, east, canopy });
  if (canopyCache.length > CANOPY_CACHE_MAX) canopyCache.pop();

  return cloneCanopy(canopy);
}

/**
 * Fetches subway station entrance and station nodes from Overpass.
 * Non-critical — returns empty array on failure instead of throwing.
 */
export async function fetchStationEntrances(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal
): Promise<StationEntranceNode[]> {
  return (await fetchStationEntranceBoxes([{ south, west, north, east }], signal)).entrances;
}

/**
 * A bounding box of `radiusM` around a point. Longitude degrees shrink with
 * latitude, so the east-west padding is widened to keep the box square in
 * metres rather than in degrees.
 */
export function boxAround(lat: number, lon: number, radiusM: number): BboxBounds {
  const latDeg = radiusM / 111_320;
  const lonDeg = latDeg / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  return { south: lat - latDeg, west: lon - lonDeg, north: lat + latDeg, east: lon + lonDeg };
}

/**
 * Fetches entrances for several boxes in **one** Overpass request.
 *
 * Entrances are only ever needed within a few hundred metres of a station, so
 * asking for a couple of small boxes costs the API far less than one box drawn
 * around the whole route — which is what this replaces. Overpass takes any
 * number of statements in a single union, so N boxes are still one request.
 *
 * Each box is cached separately, so a later route that reuses one station and
 * not the other still pays for only the new box.
 */
export interface StationEntranceResult {
  entrances: StationEntranceNode[];
  /**
   * True when the upstream request failed, so `entrances` holds only whatever
   * was already cached. An empty list then means "not known", not "none here" —
   * a distinction the caller needs, because a rate-limited Overpass and a
   * genuinely door-less area used to be indistinguishable.
   */
  failed: boolean;
}

export async function fetchStationEntranceBoxes(
  boxes: BboxBounds[],
  signal?: AbortSignal
): Promise<StationEntranceResult> {
  if (boxes.length === 0) return { entrances: [], failed: false };

  const cached: StationEntranceNode[] = [];
  const missing: BboxBounds[] = [];
  for (const box of boxes) {
    const hit = stationEntranceCache.find((entry) =>
      cacheContains(entry, box.south, box.west, box.north, box.east)
    );
    if (hit) cached.push(...hit.entrances);
    else missing.push(box);
  }

  const dedupe = (nodes: StationEntranceNode[]): StationEntranceNode[] => {
    const seen = new Set<number>();
    return nodes.filter((node) => !seen.has(node.id) && seen.add(node.id));
  };

  if (missing.length === 0) return { entrances: cloneStationEntrances(dedupe(cached)), failed: false };

  const clauses = missing
    .map(
      (box) => `
  node["railway"="subway_entrance"](${box.south},${box.west},${box.north},${box.east});
  node["railway"="station"]["station"="subway"](${box.south},${box.west},${box.north},${box.east});`
    )
    .join("");

  const query = `
[out:json][timeout:10];
(${clauses}
);
out body;`.trim();

  const encodedBody = `data=${encodeURIComponent(query)}`;

  try {
    const res = await postOverpass(encodedBody, signal);
    if (!res.ok) return { entrances: cloneStationEntrances(dedupe(cached)), failed: true };
    const text = await res.text();
    if (text.trimStart().startsWith("<"))
      return { entrances: cloneStationEntrances(dedupe(cached)), failed: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = JSON.parse(text) as { elements?: any[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const elements: any[] = json.elements ?? [];
    const entrances: StationEntranceNode[] = elements
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((e: any) => e.type === "node" && e.lat != null && e.lon != null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) => ({
        id: e.id,
        lat: e.lat,
        lon: e.lon,
        name: e.tags?.name ?? e.tags?.["name:en"] ?? undefined,
        kind: e.tags?.railway === "subway_entrance" ? "entrance" : "station",
      }));
    // Each fetched box caches the whole response rather than its own share of
    // it. Partitioning geometrically would assume Overpass never returns a node
    // outside the bounds asked for, and buys nothing: the extra entries are at
    // worst a few distant nodes, which the caller rejects by distance anyway.
    for (const box of missing) {
      stationEntranceCache.unshift({ ...box, entrances });
      if (stationEntranceCache.length > STATION_ENTRANCE_CACHE_MAX) {
        stationEntranceCache.pop();
      }
    }
    return { entrances: cloneStationEntrances(dedupe([...cached, ...entrances])), failed: false };
  } catch {
    return { entrances: cloneStationEntrances(dedupe(cached)), failed: true };
  }
}
