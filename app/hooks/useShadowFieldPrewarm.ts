import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type maplibregl from "maplibre-gl";
import { acquireNavigationSnapshot } from "../lib/navigationData/remoteNavigation";
import type { NavigationSnapshot } from "../lib/navigationData/remoteNavigation";
import { ROUTE_READINESS_BUDGET_MS } from "../lib/navigationHelpers";
import {
  bboxAroundEdges,
  QUERY_PAD_M,
} from "../lib/shadowField/ShadowField";
import type { ShadowField } from "../lib/shadowField/ShadowField";

/**
 * Below this zoom the renderer does not draw building geometry
 * (`LocalShadowAdapter` bails at the same floor), so the default world view is
 * no place to spend readiness. The prewarm claims a generation only once a
 * camera that can actually use building data has settled.
 */
const PREWARM_MIN_ZOOM = 12;

export interface UseShadowFieldPrewarmArgs {
  mapRef: MutableRefObject<maplibregl.Map | null>;
  /** The published NYC pin generation; undefined until the health check resolves. */
  generation: string | undefined;
  /** True once the map's shadow layer exists — the settle signal to prewarm after. */
  shadowLayerReady: boolean;
  shadowField: ShadowField | null;
  bindStaticSnapshot: (snapshot: NavigationSnapshot | null) => void;
}

/**
 * Page-load field prewarm (latency session A2).
 *
 * Once the map and its shadow layer exist, materialize the shadow field for
 * the camera's bbox — the same broad readiness a route calculation asks for —
 * so the first calculation finds the area cached and `field.ready` /
 * `field.readyEdges` return immediately. The cost moves off the route path to
 * page load, under the same `ROUTE_READINESS_BUDGET_MS` deadline a route gets.
 *
 * One materialization per published generation: whatever the pointer says when
 * this page loaded is what gets prewarmed, and a pointer promotion re-runs the
 * hook rather than reusing the old generation's area. `useRouting` deliberately
 * has no knowledge of this — it keeps awaiting the same two readiness calls and
 * finds them cached.
 */
export function useShadowFieldPrewarm({
  mapRef,
  generation,
  shadowLayerReady,
  shadowField,
  bindStaticSnapshot,
}: UseShadowFieldPrewarmArgs): void {
  const warmedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!shadowLayerReady || !shadowField) return;
    const map = mapRef.current;
    if (!map) return;
    const field = shadowField;
    const controller = new AbortController();
    let disposed = false;

    const tryPrewarm = () => {
      if (disposed || controller.signal.aborted) return;
      // The default world view has no buildings and publishes no route; skip it
      // without claiming the generation, and take the first useful camera.
      if (map.getZoom() < PREWARM_MIN_ZOOM) return;

      const bounds = map.getBounds();
      const genKey = generation ?? "none";
      const camera = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
        map.getZoom().toFixed(3),
      ]
        .map((v) => String(v))
        .join(",");
      const key = `${genKey}@${camera}`;
      if (warmedKeyRef.current === key) return;
      // One answer per generation: a later pan is a different page, not a reason
      // to re-burst a volunteer API the route no longer needs to pay.
      if (warmedKeyRef.current?.startsWith(`${genKey}@`)) return;
      warmedKeyRef.current = key;

      // The same broad shape the route asks for, padded by the same
      // `QUERY_PAD_M`, so the route's `field.ready(shadowBbox)` finds it.
      const prewarmBbox = bboxAroundEdges(
        [{ from: [bounds.getWest(), bounds.getSouth()], to: [bounds.getEast(), bounds.getNorth()] }],
        QUERY_PAD_M,
      )!;
      const startedAt = performance.now();

      void (async () => {
        // Bind the static building provider to the current generation *before*
        // readiness runs, so the prewarm covers the same source a route prefers.
        // A failed/absent snapshot leaves static off and the live providers
        // still prewarm; transient failures never clear a bound lease.
        let snapshot: NavigationSnapshot | null = null;
        try {
          snapshot = await acquireNavigationSnapshot({ signal: controller.signal });
        } catch {
          if (disposed || controller.signal.aborted) return;
        }
        if (disposed || controller.signal.aborted) return;
        if (snapshot) bindStaticSnapshot(snapshot);

        try {
          await field.ready(prewarmBbox, {
            signal: controller.signal,
            deadlineAt: Date.now() + ROUTE_READINESS_BUDGET_MS,
          });
        } catch {
          // `ready` never rejects; this is belt for a future provider change.
        }
        if (disposed) return;
        const elapsedMs = performance.now() - startedAt;
        if (process.env.NODE_ENV !== "production") {
          console.log(
            `[navigation] page-load field prewarm: ${elapsedMs.toFixed(0)} ms ` +
              `(${snapshot?.generation ?? "no snapshot"}, ${camera})`,
          );
        }
        (
          window as unknown as { __umbraFieldPrewarmMs?: number }
        ).__umbraFieldPrewarmMs = elapsedMs;
      })();
    };

    // Once now — the camera may already be the shared link's — and once on each
    // "camera stopped" signal, so waiting for the URL camera never warms the
    // default world view instead.
    tryPrewarm();
    map.once("moveend", tryPrewarm);
    map.once("idle", tryPrewarm);

    return () => {
      disposed = true;
      map.off("moveend", tryPrewarm);
      map.off("idle", tryPrewarm);
      controller.abort();
    };
  }, [generation, shadowLayerReady, shadowField, mapRef, bindStaticSnapshot]);
}
