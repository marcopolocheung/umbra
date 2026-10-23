import type * as maplibregl from "maplibre-gl";

type LayerOrderMap = Pick<maplibregl.Map, "getLayersOrder" | "moveLayer">;

// Casings precede their strokes. These lines must clear the custom layer's
// building depth, but leave the basemap's words and paired icons unobscured.
const NAVIGATION_LINES = [
  // H3b Sun Budget region: under every route, so a route drawn over it stays on top.
  "sun-budget-reach-proven-casing",
  "sun-budget-reach-proven",
  "sun-budget-reach-undecided",
  // #379: the walk behind a tapped street, above the region it explains.
  "sun-budget-walk-casing",
  "sun-budget-walk-line",
  "nav-route-casing",
  "nav-route-line",
  "train-route-lines-casing",
  "train-route-lines-layer",
  "mrt-entrance-connector-casing",
  "mrt-entrance-connector-line",
  "sketch-line-casing",
  "sketch-line-layer",
  "sketch-preview-layer",
] as const;

// Discrete stops are navigation markers, like the DOM pins, rather than paths.
const TRANSIT_MARKERS = [
  // #379: where a Sun Budget walk ends — a marker, like the stops.
  "sun-budget-walk-end",
  "train-route-stops-layer",
  "train-route-transfers-outer",
  "train-route-transfers-inner",
] as const;

/** Reconcile the GL stack after any late-added navigation or shadow layer. */
export function reconcileMapLayerOrder(
  map: LayerOrderMap,
  basemapSymbolIds: readonly string[],
  shadowLayerId?: string,
): void {
  const order = map.getLayersOrder();
  const present = new Set(order);
  const desired = [
    ...(shadowLayerId ? [shadowLayerId] : []),
    ...NAVIGATION_LINES,
    ...basemapSymbolIds,
    ...TRANSIT_MARKERS,
  ].filter((id) => present.has(id));

  // Shadow recomputation emits idle often. An already ordered stack needs no
  // style mutation and must not start another render/idle cycle.
  if (desired.every((id, index) => order[order.length - desired.length + index] === id)) return;

  for (const id of desired) {
    try {
      map.moveLayer(id);
    } catch {
      // A style update can temporarily remove a layer. The next pass retries.
    }
  }
}
