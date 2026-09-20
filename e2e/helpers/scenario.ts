import type { Page } from "@playwright/test";
import { fixtureBasemapStyle } from "../fixtures/basemapStyle";
import {
  navigationFixtureArtifacts,
  type NavigationFixtureKind,
} from "../fixtures/navigationShards";
import { overpassGridResponse } from "../fixtures/overpassGrid";
import { transitFixtureArtifacts, type TransitFixtureKind } from "../fixtures/transitShards";

// Midtown Manhattan at z17 on the June solstice morning: dense towers, low sun,
// long shadows. Fixed on purpose — the assertions are pixel counts, and a moving
// camera or clock makes them unrepeatable. The `fixture` basemap keeps the same
// coordinates: nothing real is fetched there, but the Overpass street grid and
// the waypoints below are already anchored here.
export const CENTER = { lat: 40.754, lng: -73.984, zoom: 17 };
export const WAYPOINT_A: [number, number] = [-73.9855, 40.753];
export const WAYPOINT_B: [number, number] = [-73.9825, 40.755];
export const START_TIME = "09:00";
export const START_MINUTES = 9 * 60;
// Straight-line A→B is ~340 m, under the 500 m threshold that pulls the transit
// graph in — one fewer network dependency for the same route assertion.
/**
 * The transit assertion needs its own pair: A→B above is deliberately ~340 m,
 * under the 500 m threshold that pulls the transit graph in. These sit at
 * opposite corners of the same grid, ~950 m apart.
 */
export const TRANSIT_WAYPOINT_A: [number, number] = [-73.9871, 40.7518];
export const TRANSIT_WAYPOINT_B: [number, number] = [-73.9809, 40.7562];

/** Must match `VITE_TRANSIT_BASE` in `playwright.config.ts`'s webServer env. */
export const TRANSIT_BASE = "https://transit.e2e.test";

/** Must match `VITE_NAVIGATION_BASE` in `playwright.bench.config.ts`'s webServer env. */
export const NAVIGATION_BASE = "https://navigation.e2e.test";

export const SHARE_URL =
  `/?lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}` +
  `&date=2026-06-21&time=${START_TIME}` +
  `&a=${WAYPOINT_A[0]},${WAYPOINT_A[1]}&b=${WAYPOINT_B[0]},${WAYPOINT_B[1]}`;

export const TRANSIT_SHARE_URL =
  `/?lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}` +
  `&date=2026-06-21&time=${START_TIME}` +
  `&a=${TRANSIT_WAYPOINT_A[0]},${TRANSIT_WAYPOINT_A[1]}` +
  `&b=${TRANSIT_WAYPOINT_B[0]},${TRANSIT_WAYPOINT_B[1]}`;

// Dragging the timeline left advances time: TimelineSlider maps 2 px to a minute
// and subtracts the drag delta, so -360 px is +3 h — 09:00 to noon, which moves
// every shadow in the frame.
export const DRAG_PX_PER_MIN = 2;
export const DRAG_MINUTES = 180;
export const INERTIA_CUTOFF_MS = 80;

// Every 8th pixel in both axes: ~18k samples off a 1280×900 canvas, enough to
// measure a shadow field without shipping 4.6 MB per read across CDP.
export const SAMPLE_STEP = 8;

/** Which basemap the run is testing against. See `playwright.config.ts`. */
export type Basemap = "fixture" | "live";

/** Which transit dataset the stub serves. `fixture` is the 3-station smoke line. */
export type StubNetworkOptions = {
  basemap: Basemap;
  transit?: TransitFixtureKind;
  /**
   * Which static navigation dataset the stub serves. `off` (the default)
   * aborts the navigation origin so the unconfigured-build path — immediate
   * Overpass fallback, no static request — stays what the scenario measures;
   * `scale` serves the seeded pointer → manifest → street/building shard
   * fixture the latency-attribution bench (session A4) times. Only meaningful
   * in builds that set `VITE_NAVIGATION_BASE` (the bench config).
   */
  navigation?: NavigationFixtureKind;
};

const MAPTILER_STYLE_URL = "**api.maptiler.com/maps/outdoor-v2/style.json*";

/**
 * Install every network stub the smoke test needs.
 *
 * Registration order matters: Playwright gives precedence to the most recently
 * registered matching route, so the blanket MapTiler abort goes in *before* the
 * style handler that has to win.
 */
export async function stubNetwork(page: Page, opts: StubNetworkOptions): Promise<void> {
  const transit = transitFixtureArtifacts(opts.transit ?? "fixture");
  const navigation = navigationFixtureArtifacts(opts.navigation ?? "off");
  if (opts.basemap === "fixture") {
    // Nothing should reach MapTiler once the style is stubbed. Abort rather than
    // let a stray request quietly hit the network (or 403 without a key), so a
    // future style change fails loudly instead of skewing the pixel counts.
    await page.route("**api.maptiler.com/**", (route) => route.abort());
    await page.route(MAPTILER_STYLE_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtureBasemapStyle()),
      }),
    );
  }

  // The published transit dataset, served from the fixture rather than R2. The
  // bucket's CORS allowlist covers the deployed origin and localhost:5173, not
  // the 127.0.0.1 this suite runs on, so a real fetch could never work here —
  // and CI must stay hermetic anyway. `opts.transit` picks which dataset the
  // run loads: the 3-station smoke line, or the seeded NYC-scale generator.
  await page.route(`${TRANSIT_BASE}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const key = path.slice(path.lastIndexOf("/") + 1);
    const body = path.endsWith("/current.json")
      ? transit.pointer
      : path.endsWith("/manifest.json")
        ? transit.manifest
        : (transit.shards.get(key) ?? null);
    if (body === null) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", body });
  });

  // The published static NYC navigation dataset, served from the fixture
  // rather than the delivery Worker. `opts.navigation` picks which dataset the
  // run loads: the keyless default is off — the bench always builds with
  // `VITE_NAVIGATION_BASE` set (the config's env cannot differ per scenario),
  // so off must make the static attempt fail instantly and fall back to
  // Overpass, which is what the committed keyless columns measured. `scale`
  // serves the seeded pointer → manifest → street/building shards fixture.
  if (!navigation) {
    await page.route(`${NAVIGATION_BASE}/**`, (route) => route.abort());
  } else {
    await page.route(`${NAVIGATION_BASE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/current.json"))
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: navigation.pointer,
        });
      if (path.endsWith("/manifest.json"))
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: navigation.manifest,
        });
      if (path.endsWith("/notices.json"))
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: navigation.notices,
        });
      const street = path.match(/\/streets\/([a-z0-9-]+\.json)$/);
      if (street) {
        const body = navigation.streetShards.get(`streets/${street[1]}`) ?? null;
        if (body === null) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ status: 200, contentType: "application/json", body });
      }
      const building = path.match(/\/buildings\/([a-z0-9-]+\.json)$/);
      if (building) {
        const body = navigation.buildingShards.get(`buildings/${building[1]}`) ?? null;
        if (body === null) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ status: 200, contentType: "application/json", body });
      }
      return route.fulfill({ status: 404, body: "" });
    });
  }

  // Overpass is stubbed in both projects: the public instance rate-limits and
  // its graph changes month to month.
  await page.route("**/api/overpass", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: overpassGridResponse,
    }),
  );

  // Reverse-geocoding the two waypoints is the app's only Nominatim call on this
  // path. `vite preview` serves no serverless functions, so /api/nominatim would
  // 404 — answer it here instead, both to keep the run hermetic and because the
  // OSMF policy is not something to lean on from a test loop.
  await page.route("**/api/nominatim*", (route) => {
    const isReverse = new URL(route.request().url()).searchParams.get("endpoint") === "reverse";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: isReverse ? JSON.stringify({ display_name: "Test Street, Test City" }) : "[]",
    });
  });

  // The cloud-cover badge's forecast fetch is the one other third party the app
  // touches on load. It feeds no assertion here, and the caller already treats a
  // failure as "no data", so cut it rather than leave an unmocked call in a test
  // that claims to be deterministic.
  await page.route("**api.open-meteo.com/**", (route) => route.abort());

  // The canopy raster: the route corridor (A8d) and the map's canopy fill (A8f) both
  // read it from a public research mirror. Cut, in both projects, for the same reason
  // as open-meteo — and because a fill painted or not depending on that host's day
  // would move the shadow pixel counts. Both consumers treat a failed read as "no
  // canopy known here", which is what this run then tests.
  await page.route("**data.source.coop/**", (route) => route.abort());
}
