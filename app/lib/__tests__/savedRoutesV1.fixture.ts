/**
 * A real v1 saved-route record: exactly what `createRoute` wrote before the
 * `Trip` model (no `version`, no `trip`). Kept as JSON-shaped data — the
 * migration test round-trips it through `JSON.stringify` first, so this
 * fixture proves the migration reads what is actually on disk, not a
 * hand-shaped object.
 */
export const V1_SAVED_ROUTE = {
  id: "v1-record-1",
  name: "Coffee then park",
  folderId: null,
  routeOption: {
    label: "Balanced",
    geojson: {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [-3.7, 40.41],
          [-3.69, 40.415],
          [-3.68, 40.42],
        ],
      },
    },
    distanceM: 1500,
    shadowCoverage: 0.6,
    longestContinuousShadowM: 300,
    longestContinuousSunM: 120,
    shadowTransitions: 4,
    detourRatio: 1.1,
    turnCount: 5,
  },
  waypointA: [-3.7, 40.41],
  waypointB: [-3.68, 40.42],
  waypointALabel: "Café",
  waypointBLabel: "Park",
  additionalWaypoints: [[-3.69, 40.415]],
  timeOfDayMinutes: 9 * 60 + 30,
  dateIso: "2026-08-16",
  createdAt: 1755346200000,
};
