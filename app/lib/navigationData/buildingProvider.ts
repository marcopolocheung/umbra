/**
 * Static NYC building prisms for the shadow field (Checkpoint 4).
 *
 * The live providers answer from what the renderer loaded (tiles) or from a
 * rate-limited public API (Overpass). This one answers from the published,
 * digest-verified building shards the route already trusts for its streets:
 * whole footprints with pinned heights, selected by caster reach rather than
 * by viewport. It sits first in the building provider list inside verified
 * NYC coverage; outside it — or when its load fails — it declines and the
 * current providers answer exactly as before.
 *
 * One instance is long-lived (it lives in the calculation's provider list
 * alongside the long-lived tile/Overpass/canopy providers), but the data it
 * may serve is not: every calculation binds the route-scoped
 * `NavigationSnapshot` it already shares with the street graph via
 * `bindSnapshot`, before graph fetch and field readiness start in parallel.
 * That bind is the lease the handoff asks for — the provider never re-reads
 * `current.json` on its own, so a pointer promotion mid-calculation cannot
 * mix generations inside one route. Binding a different generation drops the
 * decoded cache wholesale (single-assignment, like the loader's own cache);
 * rebinding the same generation keeps it, so recalculations stay warm.
 *
 * The query-time contract is synchronous, as the field requires:
 *
 * - `load(bbox, signal)` selects, fetches, verifies, decodes, converts, and
 *   atomically publishes. `prismsFor` never reaches the network.
 * - `prismsFor(bbox)` returns `null` for unloaded, failed, incomplete,
 *   out-of-support, or generation-rolled data — never a confident empty city.
 * - A verified covered area with zero buildings returns a valid empty
 *   `PrismSet`; the field's existing no-geometry confidence dock still
 *   applies to it.
 * - The same prism-array identity is returned while cached, which is what
 *   the field's prepared-caster `WeakMap` keys on.
 */

import { bboxContains, type BBox, type PrismProvider } from "../shadowField/ShadowField";
import {
  type BuildingFootprintLike,
  type PrismSet,
  prismsFromFootprints,
} from "../shadowField/geometry";
import type { NavigationPhases } from "./navigationPhases";
import {
  DEFAULT_CASTER_REACH_M,
  loadNavigationBuildingShards,
  selectNavigationShards,
  type NavigationRequestOptions,
  type NavigationSnapshot,
} from "./remoteNavigation";
import type {
  GeoBounds,
  NavigationBuilding,
  NavigationBuildingShard,
} from "./shardContract";

/**
 * Height assigned to a published building whose height is explicitly unknown
 * (`heightM: null`, `heightSource: "unknown"`).
 *
 * This is the v1 missing-height policy, and it is deliberately the same
 * conservative 10 m the live Overpass path assigns an untagged way
 * (`heightMForBuilding` in `overpass.ts`): unknown static geometry must cast
 * no smaller a shadow than unknown live geometry, or switching sources would
 * quietly move shade. It is not the tile default (3.1 m), which would
 * under-report shade beside an unseen tower. The contract keeps `null`
 * distinct from zero and from a fallback height
 * (`docs/notes/nyc-navigation-data-contract.md`), and each shard ref counts
 * its unknowns (`missingHeights`), so the prevalence is observable per
 * generation rather than hidden in this constant. A typed-by-feature-class
 * rule may replace it once its evidence exists; until then this constant —
 * not a silent MapTiler confidence — is the documented prior.
 */
export const NYC_UNKNOWN_HEIGHT_M = 10;

/** Published selections to keep. Each holds one padded request's prisms. */
const STATIC_CACHE_ENTRIES = 8;

export interface NycStaticPrismProviderOptions extends NavigationRequestOptions {
  /**
   * How far beyond the requested bbox a building may stand and still be
   * selected as a shadow caster. Defaults to the same 400 m the shadow field
   * already pads its sampling queries with (`QUERY_PAD_M`), so a caster that
   * can reach the query is always loaded with it.
   */
  casterReachM?: number;
  /** Override for `NYC_UNKNOWN_HEIGHT_M`. A test seam, not a second policy. */
  missingHeightM?: number;
}

interface PublishedSelection {
  /** The requested bbox whose selection verified — the entry speaks for it. */
  coverage: BBox;
  set: PrismSet;
}

/**
 * A building provider over the static NYC dataset, pinned to one snapshot.
 *
 * Beyond `PrismProvider` it exposes the bound `generation` (null when
 * unbound) so diagnostics can name the exact dataset a shadow answer came
 * from. `bindSnapshot` is the per-calculation lease: call it with the same
 * snapshot the street graph loads through, before field readiness starts.
 */
export interface NycStaticBuildingProvider extends PrismProvider {
  source: "nyc-static";
  generation: string | null;
  bindSnapshot(snapshot: NavigationSnapshot | null): void;
  /**
   * Binds the per-calculation phase collector. The provider is long-lived and
   * shared; a calculation binds its collector beside `bindSnapshot` and the
   * next bind replaces it, exactly like the generation lease it accompanies.
   */
  bindReport(report: NavigationPhases | null): void;
}

function abortError(): Error {
  const error = new Error("NYC static building load aborted");
  error.name = "AbortError";
  return error;
}

function toGeoBounds(bbox: BBox): GeoBounds {
  return { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east };
}

function toFootprint(
  building: NavigationBuilding,
  missingHeightM: number,
): BuildingFootprintLike {
  return {
    heightM: building.heightM ?? missingHeightM,
    rings: building.rings,
  };
}

export function createNycStaticPrismProvider(
  opts?: NycStaticPrismProviderOptions,
): NycStaticBuildingProvider {
  const fetchFn = opts?.fetchFn;
  const casterReachM = opts?.casterReachM ?? DEFAULT_CASTER_REACH_M;
  const missingHeightM = opts?.missingHeightM ?? NYC_UNKNOWN_HEIGHT_M;
  let bound: NavigationSnapshot | null = null;
  let boundReport: NavigationPhases | null = null;
  const cache: PublishedSelection[] = [];

  function lookup(bbox: BBox): PrismSet | null {
    for (let i = 0; i < cache.length; i++) {
      if (bboxContains(cache[i].coverage, bbox)) {
        // Most-recently-used to the front, like the Overpass provider's cache:
        // a route re-asks the same cells through sampling, coverage, and sweep.
        const [entry] = cache.splice(i, 1);
        cache.unshift(entry);
        return entry.set;
      }
    }
    return null;
  }

  /**
   * Publish one verified selection. Runs synchronously once every required
   * shard has verified, so a caller never sees a half-static prism set — and
   * only when still bound to the snapshot the load started from, so a load
   * overtaken by a generation rollover cannot publish stale data under it.
   */
  function publish(bbox: BBox, set: PrismSet, snapshot: NavigationSnapshot, report: NavigationPhases | null): void {
    if (bound !== snapshot) return;
    cache.unshift({ coverage: { ...bbox }, set });
    if (report) {
      report.buildingPrismCount = set.prisms.length;
      report.generation = snapshot.generation;
    }
    if (cache.length > STATIC_CACHE_ENTRIES) cache.length = STATIC_CACHE_ENTRIES;
    if (import.meta.env.DEV) {
      console.log(
        "[navigation] using static buildings:",
        `generation ${snapshot.generation},`,
        `${set.prisms.length} prisms,`,
        `max height ${set.maxHeightM} m`,
      );
    }
  }

  const provider: NycStaticBuildingProvider = {
    source: "nyc-static",

    get generation() {
      return bound?.generation ?? null;
    },

    bindReport(report: NavigationPhases | null) {
      boundReport = report;
    },

    bindSnapshot(snapshot: NavigationSnapshot | null) {
      if (bound?.generation === snapshot?.generation) return;
      // Single-assignment rollover, mirroring the loader's own generation
      // cache: readers never see a half-rolled mix of two generations.
      bound = snapshot;
      cache.length = 0;
    },

    prismsFor(bbox) {
      if (!bound) return null;
      return lookup(bbox);
    },

    async load(bbox, signal) {
      const snapshot = bound;
      if (!snapshot) return;
      if (signal?.aborted) throw abortError();
      if (lookup(bbox)) {
        // The synchronous prism cache answered: nothing fetched, nothing
        // decoded. Counted as a hit rather than as a fake transfer.
        if (boundReport) boundReport.buildingPrismCacheHit = true;
        return;
      }
      // Captured beside `snapshot`: a mid-flight rebind to a new calculation
      // stops its loads from attributing phases to the old one's collector.
      const report = boundReport;

      // Caster-reach selection, not centroid containment: a tall footprint
      // outside the route bbox still casts onto it, and the producer assigns
      // every building to exactly one owner cell, so owner shards whose
      // geometry overlaps the reach-expanded request are the complete set.
      const refs = selectNavigationShards(snapshot.manifest, toGeoBounds(bbox), casterReachM);
      // Outside verified support: decline, and let tiles/Overpass answer.
      if (!refs) return;

      let shards: NavigationBuildingShard[];
      try {
        // Selected refs go through the same generation decoded cache the street
        // path uses: a second query over a different padded bbox serves the
        // verified shard from memory instead of transferring it again.
        shards = await loadNavigationBuildingShards(snapshot, refs.buildings, {
          fetchFn,
          signal,
          report: report ?? undefined,
        });
      } catch (error) {
        // A caller abort is not a static failure: rethrow without launching
        // fallback network work. A missing or corrupt shard leaves nothing
        // cached, so `prismsFor` keeps returning null and the field reports
        // unknown — never a confident empty city.
        if (signal?.aborted) throw error instanceof Error ? error : abortError();
        return;
      }
      const tConvert = globalThis.performance?.now?.() ?? 0;
      if (signal?.aborted) throw abortError();

      // Whole footprints, seam-safe: every ring of every selected shard is
      // included (the selection, not the bbox, decides membership), and a
      // building id published by two cells — which the producer contract
      // forbids, but a corrupt generation could contain — casts once rather
      // than twice. Each ring becomes its own prism through the same
      // `prismsFromFootprints` path the Overpass provider uses, so multiparts
      // and holes behave exactly as the current prism model handles them.
      const seen = new Set<string>();
      const footprints: BuildingFootprintLike[] = [];
      for (const shard of shards) {
        for (const building of shard.buildings) {
          if (seen.has(building.id)) continue;
          seen.add(building.id);
          footprints.push(toFootprint(building, missingHeightM));
        }
      }
      const set = prismsFromFootprints(footprints);
      if (report) report.buildingConvertMs += (globalThis.performance?.now?.() ?? 0) - tConvert;
      publish(bbox, set, snapshot, report);
    },
  };

  return provider;
}
