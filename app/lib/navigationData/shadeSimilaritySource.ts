/** A3: local PCA shortlist, exact annual rerank, then A1 window observations. */
import {
  acquireNavigationSnapshot,
  loadNavigationStreetShards,
  loadNavigationShadeShard,
  loadNavigationSignatureIndex,
  loadNavigationSignatureShard,
  loadShadeSlotBlocks,
  selectNavigationShardsForBoxes,
  zoneAround,
  type NavigationRequestOptions,
} from "./remoteNavigation";
import { loadProfileIndex, loadProfileCell, loadAnnualProfiles } from "./profileSource";
import { createSignatureView } from "./signatureView";
import {
  createShadeSpotsView,
  prepareShadeSpotsWindow,
  shadeSpotGeometry,
  shadeSpots,
  type ShadeSpot,
  type ShadeSpotsQuery,
} from "./shadeSpots";
import { shadeUnavailable, type ShadeWindowPayload } from "./shadeSpotsSource";
import { QUARANTINED_SHADE_GENERATIONS } from "./shadeTable";
export function annualSquaredDistance(a: Uint8Array, b: Uint8Array): number {
  if (!a.length || a.length !== b.length) throw new Error("annual profiles differ in size");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum;
}
export async function findSimilarShadeSpots(
  reference: ShadeSpot,
  input: ShadeSpotsQuery,
  options?: NavigationRequestOptions,
): Promise<ShadeWindowPayload> {
  const signal = options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const request = { ...options, signal };
  try {
    const snapshot = await acquireNavigationSnapshot(request);
    if (!snapshot) return shadeUnavailable("not_configured");
    if (QUARANTINED_SHADE_GENERATIONS.has(snapshot.generation))
      return shadeUnavailable("quarantined_generation");
    if (!reference.candidateId.startsWith(`${snapshot.generation}:`))
      return shadeUnavailable("stale_reference");
    if (!snapshot.manifest.profiles || !snapshot.manifest.signatures)
      return shadeUnavailable("no_similarity_data");
    const owner = snapshot.manifest.shadeShards?.find((s) => s.key === reference.shadeKey);
    const ownerStreet = snapshot.manifest.streetShards.find(
      (s) => s.key === reference.shadeKey?.replace("shades/", "streets/"),
    );
    if (!owner || !ownerStreet) return shadeUnavailable("invalid_reference");
    const [firstShade, firstStreet] = await Promise.all([
      loadNavigationShadeShard(snapshot, owner, request),
      loadNavigationStreetShards(snapshot, [ownerStreet], request).then((s) => s[0]),
    ]);
    const initial = createShadeSpotsView([firstStreet], [{ shard: firstShade, blocks: new Map() }]);
    const segment = initial.segments.find((s) => s.key === reference.segmentKey);
    if (!segment || !firstShade.segments.some(([a, b]) => `${a},${b}` === reference.segmentKey))
      return shadeUnavailable("invalid_reference");
    const query = {
      ...input,
      lng: (segment.edge.from[0] + segment.edge.to[0]) / 2,
      lat: (segment.edge.from[1] + segment.edge.to[1]) / 2,
    };
    const prepared = prepareShadeSpotsWindow(query);
    if (!prepared.effectiveWindow) return shadeUnavailable("empty_window");
    const box = zoneAround(query.lng, query.lat, query.radiusM);
    const selected = selectNavigationShardsForBoxes(
      snapshot.manifest,
      { west: query.lng, east: query.lng, south: query.lat, north: query.lat },
      [box],
      0,
    );
    if (!selected) return shadeUnavailable("outside_coverage");
    const shadeRefs = new Map(selected.shadeShards.map((s) => [s.key, s]));
    shadeRefs.set(owner.key, owner);
    const streetRefs = new Map(selected.streets.map((s) => [s.key, s]));
    for (const shade of shadeRefs.values()) {
      const street = snapshot.manifest.streetShards.find(
        (s) => s.key === shade.key.replace("shades/", "streets/"),
      );
      if (!street) throw new Error("owner geometry missing");
      streetRefs.set(street.key, street);
    }
    const [shades, streets, signatures] = await Promise.all([
      Promise.all(
        [...shadeRefs.values()].map((s) =>
          s.key === owner.key ? firstShade : loadNavigationShadeShard(snapshot, s, request),
        ),
      ),
      Promise.all(
        [...streetRefs.values()].map((s) =>
          s.key === ownerStreet.key
            ? firstStreet
            : loadNavigationStreetShards(snapshot, [s], request).then((v) => v[0]),
        ),
      ),
      loadNavigationSignatureIndex(snapshot, request),
    ]);
    if (!signatures) return shadeUnavailable("no_similarity_data");
    const index = await loadProfileIndex(snapshot, signatures, request);
    if (!index) return shadeUnavailable("no_similarity_data");
    const empty = shades.map((shard) => ({ shard, blocks: new Map<number, Uint8Array>() }));
    const view = createShadeSpotsView(streets, empty);
    if (view.missingGeometry) throw new Error("incomplete geometry");
    const geometry = shadeSpotGeometry(view, query);
    const anchor = geometry.find((s) => s.candidateId === reference.candidateId);
    if (!anchor) return shadeUnavailable("night");
    const eligible = geometry.filter((s) => s.blockFaceId !== anchor.blockFaceId);
    if (!eligible.length) return shadeUnavailable("no_candidates");
    const signatureCells = await Promise.all(
      shades.map(async (shard) => ({
        shard,
        payload: await loadNavigationSignatureShard(
          snapshot,
          signatures,
          shard.payload.key.split("/")[1].replace(/\.bin$/, ""),
          request,
        ),
      })),
    );
    const signatureView = createSignatureView(signatures, signatureCells);
    const neighbours = signatureView.nearest(
      anchor.key,
      anchor.signatureSide,
      500,
      new Set(eligible.map((s) => `${s.key}/${s.signatureSide}`)),
    );
    if (!neighbours?.length) return shadeUnavailable("no_candidates");
    const sides = new Map(geometry.map((s) => [`${s.key}/${s.signatureSide}`, s]));
    const wanted = [anchor, ...neighbours.map((n) => sides.get(`${n.key}/${n.side}`)!)];
    const wantedIds = new Set(wanted.map((s) => `${s.key}/${s.signatureSide}`));
    const ownerRows = new Map<string, { shard: typeof firstShade; rows: number[] }>();
    const rowOf = new Map<string, string>();
    for (const shard of shades)
      for (let segmentIndex = 0; segmentIndex < shard.segments.length; segmentIndex++) {
        const [lo, hi] = shard.segments[segmentIndex];
        for (const side of [0, 1] as const) {
          const id = `${lo},${hi}/${side}`;
          if (!wantedIds.has(id)) continue;
          const row = segmentIndex * 2 + side;
          rowOf.set(id, `${shard.payload.key.replace(/\.bin$/, ".json")}/${row}`);
          const read = ownerRows.get(shard.payload.key) ?? { shard, rows: [] };
          read.rows.push(row);
          ownerRows.set(shard.payload.key, read);
        }
      }
    const reads = await Promise.all(
      [...ownerRows.values()].map(async ({ shard, rows }) => ({
        cell: await loadProfileCell(snapshot, index, shard, request),
        rows,
      })),
    );
    const profiles = await loadAnnualProfiles(snapshot, index, reads, request);
    const profile = (id: string) => {
      const bytes = profiles.get(rowOf.get(id)!);
      if (!bytes) throw new Error("missing annual side");
      return bytes;
    };
    const annualReference = profile(`${anchor.key}/${anchor.signatureSide}`);
    const ranked = neighbours
      .map((n) => ({
        spot: sides.get(`${n.key}/${n.side}`)!,
        distance: annualSquaredDistance(annualReference, profile(`${n.key}/${n.side}`)),
      }))
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          a.spot.distanceM - b.spot.distanceM ||
          (a.spot.candidateId < b.spot.candidateId
            ? -1
            : a.spot.candidateId > b.spot.candidateId
              ? 1
              : 0),
      );
    const faces = new Set<string>();
    const best = ranked
      .filter((r) => {
        if (faces.has(r.spot.blockFaceId)) return false;
        faces.add(r.spot.blockFaceId);
        return true;
      })
      .slice(0, 4);
    const ids = new Set([reference.candidateId, ...best.map((r) => r.spot.candidateId)]);
    const requiredKeys = new Set(
      wanted
        .filter((s) => ids.has(s.candidateId))
        .map((s) => rowOf.get(`${s.key}/${s.signatureSide}`)!.replace(/\/\d+$/, "")),
    );
    const windows = await Promise.all(
      shades.map(async (shard) => ({
        shard,
        blocks: requiredKeys.has(shard.payload.key.replace(/\.bin$/, ".json"))
          ? await loadShadeSlotBlocks(
              snapshot,
              shard,
              prepared.slots.map((s) => s.slot),
              request,
            )
          : new Map<number, Uint8Array>(),
      })),
    );
    const observed = shadeSpots(createShadeSpotsView(streets, windows), query, {
      candidateIds: ids,
      all: true,
    });
    const referenceSpot = observed.results.find((s) => s.candidateId === reference.candidateId);
    const results = best.map(
      (r) => observed.results.find((s) => s.candidateId === r.spot.candidateId)!,
    );
    if (!referenceSpot || results.some((s) => !s) || observed.skippedSegments)
      throw new Error("incomplete comparison window");
    const support = snapshot.manifest.supportBounds;
    if (
      box.south < support.south ||
      box.north > support.north ||
      box.west < support.west ||
      box.east > support.east
    )
      observed.reasons.push("incomplete-data");
    return {
      ...observed,
      results,
      generation: snapshot.generation,
      status: "ok",
      source: "nyc-shade-table",
      sourceVersion: snapshot.generation,
      requestedDate: query.date,
      mode: query.mode,
      similarity: {
        reference: referenceSpot,
        metric: "annual-daylight-l2",
        model: index.model,
        sampleCount: index.daySlots.length,
        shortlistSize: neighbours.length,
        eligibleSides: eligible.length,
        approximate: true,
        squaredDistances: Object.fromEntries(best.map((r) => [r.spot.candidateId, r.distance])),
      },
    };
  } catch {
    return shadeUnavailable("load_failed");
  }
}
