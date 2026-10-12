/** A2's bounded async adapter. Every successful cell belongs to one snapshot. */
import {
  acquireNavigationSnapshot,
  loadNavigationStreetShards,
  loadNavigationShadeShard,
  loadShadeSlotBlocks,
  selectNavigationShardsForBoxes,
  zoneAround,
  type NavigationRequestOptions,
} from "./remoteNavigation";
import {
  createShadeSpotsView,
  prepareShadeSpotsWindow,
  shadeSpots,
  type ShadeSpotsQuery,
  type ShadeSpotsResult,
} from "./shadeSpots";
import { QUARANTINED_SHADE_GENERATIONS, type ShadeTableShard } from "./shadeTable";
import type { NavigationStreetShard } from "./shardContract";

export type ShadeUnavailableReason =
  | "outside_coverage"
  | "not_configured"
  | "no_shade_table"
  | "quarantined_generation"
  | "load_failed"
  | "night"
  | "empty_window"
  | "no_candidates"
  | "invalid_query";
export type ShadeWindowPayload =
  | (ShadeSpotsResult &
      Record<string, unknown> & {
        status: "ok";
        generation: string;
        source: "nyc-shade-table";
        sourceVersion: string;
        requestedDate: string;
        mode: "shade" | "sun";
      })
  | ({ status: "unavailable"; reason: ShadeUnavailableReason; results: [] } & Record<
      string,
      unknown
    >);

export function shadeUnavailable(reason: ShadeUnavailableReason): ShadeWindowPayload {
  return { status: "unavailable", reason, results: [] };
}

export async function findShadeSpots(
  query: ShadeSpotsQuery,
  options?: NavigationRequestOptions,
): Promise<ShadeWindowPayload> {
  let prepared: ReturnType<typeof prepareShadeSpotsWindow>;
  try {
    prepared = prepareShadeSpotsWindow(query);
  } catch {
    return shadeUnavailable("invalid_query");
  }
  if (!prepared.effectiveWindow) return shadeUnavailable("empty_window");
  const signal = options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const request = { ...options, signal };
  try {
    const snapshot = await acquireNavigationSnapshot(request);
    if (!snapshot) return shadeUnavailable("not_configured");
    if (QUARANTINED_SHADE_GENERATIONS.has(snapshot.generation))
      return shadeUnavailable("quarantined_generation");
    const box = zoneAround(query.lng, query.lat, query.radiusM);
    const refs = selectNavigationShardsForBoxes(
      snapshot.manifest,
      { south: query.lat, north: query.lat, west: query.lng, east: query.lng },
      [box],
      0,
    );
    if (!refs) return shadeUnavailable("outside_coverage");
    if (!snapshot.manifest.shadeShards?.length) return shadeUnavailable("no_shade_table");
    if (!refs.shadeShards.length)
      return shadeUnavailable(refs.streets.length ? "no_shade_table" : "no_candidates");
    const support = snapshot.manifest.supportBounds;
    let incomplete =
      box.south < support.south ||
      box.north > support.north ||
      box.west < support.west ||
      box.east > support.east;
    const streetRefs = new Map(refs.streets.map((ref) => [ref.key, ref]));
    // Shade indexes need their complete owner-cell geometry, even if the street
    // bounding box selection differs at a seam. Do not truncate a sun batch.
    for (const shadeRef of refs.shadeShards) {
      const key = shadeRef.key.replace(/^shades\//, "streets/");
      const streetRef = snapshot.manifest.streetShards.find((ref) => ref.key === key);
      if (streetRef) streetRefs.set(key, streetRef);
      else incomplete = true;
    }
    const [streetLoads, shadeLoads] = await Promise.all([
      Promise.allSettled(
        [...streetRefs.values()].map(
          async (ref) => (await loadNavigationStreetShards(snapshot, [ref], request))[0],
        ),
      ),
      Promise.allSettled(
        refs.shadeShards.map(async (ref) => {
          const shard = await loadNavigationShadeShard(snapshot, ref, request);
          const blocks = await loadShadeSlotBlocks(
            snapshot,
            shard,
            prepared.slots.map((slot) => slot.slot),
            request,
          );
          return { shard, blocks };
        }),
      ),
    ]);
    const streets: NavigationStreetShard[] = [];
    const shades: ShadeTableShard[] = [];
    for (const load of streetLoads) {
      if (load.status === "fulfilled") streets.push(load.value);
      else incomplete = true;
    }
    for (const load of shadeLoads) {
      if (load.status === "fulfilled") shades.push(load.value);
      else incomplete = true;
    }
    if (options?.signal?.aborted || (!shades.length && incomplete))
      return shadeUnavailable("load_failed");
    const result = shadeSpots(createShadeSpotsView(streets, shades), query);
    if (!result.results.length)
      return shadeUnavailable(
        result.reasons.includes("night")
          ? "night"
          : result.reasons.includes("no-data") || incomplete
            ? "load_failed"
            : "no_candidates",
      );
    if (incomplete && !result.reasons.includes("incomplete-data"))
      result.reasons.push("incomplete-data");
    return {
      ...result,
      generation: snapshot.generation,
      status: "ok",
      source: "nyc-shade-table",
      sourceVersion: snapshot.generation,
      requestedDate: query.date,
      mode: query.mode,
    };
  } catch {
    return shadeUnavailable("load_failed");
  }
}
