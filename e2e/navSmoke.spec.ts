import { expect, test, type Page } from "@playwright/test";
import {
  countRouteLinePixels,
  countTransitLinePixels,
  sampleMapCanvas,
  shadowMask,
  shadowedFraction,
} from "./helpers/map";
import { CENTER, NAVIGATION_BASE, SAMPLE_STEP, START_TIME, stubNetwork } from "./helpers/scenario";

/**
 * Checkpoint 6's hermetic scenario for the published static NYC navigation
 * dataset — the one `npm run e2e` project whose build inlines
 * `VITE_NAVIGATION_BASE` (`playwright.config.ts`, the `nav-smoke` project).
 *
 * The stub serves a seeded, digest-verified pointer → manifest → street and
 * building shard fixture (`e2e/fixtures/navigationShards.ts`), and **every
 * street-graph, building-footprint, and station-entrance Overpass request is
 * forced to fail** (`overpass: "failRouting"`). Tree/woodland canopy queries
 * are deliberately left on the fixture answer — the scenario must not take
 * canopy down with the routing endpoints it is proving it does not need.
 *
 * Assertions, in order of the handoff's acceptance list: NYC walking, subway
 * access/egress and bus access/egress succeed over the static graph; an
 * outside-support request falls back (and is observable as a decline, never
 * as a static answer); no `_shadow` request occurs; and the visible map still
 * renders through its existing paths (fixture MapTiler style request, canvas,
 * painted shadows, drawn route line).
 */

const STATIC_GENERATION = "nyc-2026-09-19-abcdef123456";

/** The A4 fixture's midtown walk pair and transit pair, plus two off-grid pairs. */
const WALK_A: [number, number] = [-73.9855, 40.753];
const WALK_B: [number, number] = [-73.9825, 40.755];
const TRANSIT_A: [number, number] = [-73.9871, 40.7518];
const TRANSIT_B: [number, number] = [-73.9809, 40.7562];
/** Outside the fixture's verified support: east of the last published cell. */
const OUTSIDE_A: [number, number] = [-73.9, 40.76];
const OUTSIDE_B: [number, number] = [-73.87, 40.77];

function shareUrl(a: [number, number], b: [number, number]): string {
  const params =
    `lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}` +
    `&date=2026-06-21&time=${START_TIME}` +
    `&a=${a[0]},${a[1]}&b=${b[0]},${b[1]}`;
  return `/?${params}`;
}

interface OverpassTraffic {
  street: number;
  building: number;
  entrance: number;
  canopy: number;
  canopyStatuses: number[];
}

interface NetworkTraffic {
  overpass: OverpassTraffic;
  shadow: number;
  navigation: {
    pointer: number;
    manifest: number;
    streets: number;
    buildings: number;
  };
  maptilerStyle: number;
}

/** Collect every request class the scenario asserts on, across one page. */
function watchTraffic(page: Page): () => NetworkTraffic {
  const traffic: NetworkTraffic = {
    overpass: { street: 0, building: 0, entrance: 0, canopy: 0, canopyStatuses: [] },
    shadow: 0,
    navigation: { pointer: 0, manifest: 0, streets: 0, buildings: 0 },
    maptilerStyle: 0,
  };
  const classify = (rawBody: string) => {
    // The POST body is `data=<url-encoded query>`; classify the decoded query.
    const body = decodeURIComponent(rawBody);
    if (/way\["highway"~/.test(body)) return "street" as const;
    if (/way\["building"\]|relation\["building"\]/.test(body)) return "building" as const;
    if (/subway_entrance/.test(body)) return "entrance" as const;
    return "canopy" as const;
  };
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("_shadow")) traffic.shadow += 1;
    if (url.startsWith(NAVIGATION_BASE)) {
      if (url.endsWith("/current.json")) traffic.navigation.pointer += 1;
      else if (url.endsWith("/manifest.json")) traffic.navigation.manifest += 1;
      else if (/\/streets\//.test(url)) traffic.navigation.streets += 1;
      else if (/\/buildings\//.test(url)) traffic.navigation.buildings += 1;
    }
    if (/api\.maptiler\.com\/maps\/outdoor-v2\/style\.json/.test(url)) traffic.maptilerStyle += 1;
    if (url.endsWith("/api/overpass")) {
      const kind = classify(request.postData() ?? "");
      traffic.overpass[kind] += 1;
    }
  });
  page.on("response", (response) => {
    // The canopy response status is the only status the scenario cares about:
    // routing queries are forced to fail, canopy must stay reachable.
    if (response.url().endsWith("/api/overpass")) {
      const body = response.request().postData() ?? "";
      if (classify(body) === "canopy") traffic.overpass.canopyStatuses.push(response.status());
    }
  });
  return () => traffic;
}

interface NavigationMetrics {
  streetSource?: string;
  streetFallbackReason?: string | null;
  generation?: string | null;
  streetShardsFetched?: number;
  streetShardsServed?: number;
  buildingShardsFetched?: number;
  buildingShardsServed?: number;
  buildingPrismCount?: number;
  graphNodeCount?: number;
  graphDirectedEdges?: number;
  nycStaticShare?: number;
}

async function readNavigationMetrics(page: Page): Promise<NavigationMetrics | null> {
  return page.evaluate(() => {
    const m = (
      window as unknown as {
        __umbraMetrics?: {
          latest: {
            navigation?: Record<string, unknown>;
            graphNodeCount?: number;
            graphDirectedEdges?: number;
            buildingProviderShares?: Record<string, number>;
          } | null;
        };
      }
    ).__umbraMetrics;
    const latest = m?.latest;
    if (!latest) return null;
    const nav = latest.navigation ?? {};
    return {
      streetSource: nav.streetSource as string | undefined,
      streetFallbackReason: (nav.streetFallbackReason ?? null) as string | null,
      generation: (nav.generation ?? null) as string | null,
      streetShardsFetched: nav.streetShardsFetched as number | undefined,
      streetShardsServed: nav.streetShardsServed as number | undefined,
      buildingShardsFetched: nav.buildingShardsFetched as number | undefined,
      buildingShardsServed: nav.buildingShardsServed as number | undefined,
      buildingPrismCount: nav.buildingPrismCount as number | undefined,
      graphNodeCount: latest.graphNodeCount,
      graphDirectedEdges: latest.graphDirectedEdges,
      nycStaticShare: latest.buildingProviderShares?.["nyc-static"],
    };
  });
}

async function waitForRoutableMap(page: Page): Promise<void> {
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(async () => shadowedFraction(shadowMask(await sampleMapCanvas(page, SAMPLE_STEP))), {
      timeout: 90_000,
      message: "no blue-dominant shadow pixels ever appeared on the map",
    })
    .toBeGreaterThan(0.02);
}

async function waitForRun(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const m = (window as unknown as { __umbraMetrics?: { latest?: unknown } }).__umbraMetrics;
          return Boolean(m?.latest);
        }),
      { timeout: 60_000, message: "no routing run was ever recorded" },
    )
    .toBe(true);
}

test.describe.configure({ mode: "serial" });

test("NYC walking route: static streets and buildings, Overpass routing refused", async ({
  page,
}) => {
  const traffic = watchTraffic(page);
  await stubNetwork(page, { basemap: "fixture", navigation: "scale", overpass: "failRouting" });

  await page.goto(shareUrl(WALK_A, WALK_B));
  await waitForRoutableMap(page);

  const routeLinePixelsBefore = await countRouteLinePixels(page);
  // The page-load shadow prewarm may ask Overpass for buildings before any
  // calculation and before the static snapshot is bound; those queries are not
  // the route path. Scope the no-Overpass assertions to the clicks that start
  // a calculation.
  const preClick = traffic().overpass;
  await page.getByRole("button", { name: "Find Shadowed Route" }).click();
  await waitForRun(page);

  const metrics = await readNavigationMetrics(page);
  expect(metrics?.streetSource, "the walk must route over static NYC streets").toBe("nyc-static");
  expect(metrics?.generation).toBe(STATIC_GENERATION);
  // One z14-style cell: its 4,200-node rect + seam ghosts + the two virtual snaps.
  expect(metrics?.graphNodeCount).toBe(4332);
  expect(metrics?.graphDirectedEdges).toBe(16670);
  expect(metrics?.streetShardsFetched).toBe(1);
  // The building shard may have been fetched by the page-load prewarm rather
  // than by this calculation — either way exactly one shard was selected and
  // its 1,000 prisms answered.
  expect(
    (metrics?.buildingShardsFetched ?? 0) + (metrics?.buildingShardsServed ?? 0),
  ).toBeGreaterThanOrEqual(1);
  expect(metrics?.buildingPrismCount).toBe(1000);
  expect(metrics?.nycStaticShare ?? 0).toBeGreaterThan(0);

  await expect
    .poll(() => countRouteLinePixels(page), {
      timeout: 20_000,
      message: "the route line never appeared on the map canvas",
    })
    .toBeGreaterThan(routeLinePixelsBefore + 200);

  const live = traffic();
  expect(live.overpass.street, "no street Overpass request may reach the stub").toBe(0);
  expect(
    live.overpass.building - preClick.building,
    "the route calculation may not ask Overpass for buildings",
  ).toBe(0);
  expect(live.overpass.entrance, "no entrance Overpass request may reach the stub").toBe(0);
  expect(
    live.overpass.canopyStatuses.length > 0 ? Math.max(...live.overpass.canopyStatuses) : 200,
    "canopy Overpass traffic must not be failed alongside routing queries",
  ).toBe(200);
  expect(live.shadow, "no _shadow request may occur").toBe(0);
  expect(live.maptilerStyle).toBeGreaterThan(0);
});

test("NYC transit: subway access/egress walks on the static graph", async ({ page }) => {
  const traffic = watchTraffic(page);
  await stubNetwork(page, {
    basemap: "fixture",
    transit: "fixture",
    navigation: "scale",
    overpass: "failRouting",
  });
  // The subway-only fixture paints its line magenta, which is the one colour
  // nothing else on the map uses — the same pixel check `smoke.spec.ts` makes.

  await page.goto(shareUrl(TRANSIT_A, TRANSIT_B));
  await waitForRoutableMap(page);

  await page
    .getByRole("button", { name: "Transit", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const preClick = traffic().overpass;
  await page.getByRole("button", { name: "Find Shadowed Route" }).click();
  await waitForRun(page);

  const metrics = await readNavigationMetrics(page);
  expect(metrics?.streetSource, "subway access/egress must walk the static graph").toBe(
    "nyc-static",
  );
  expect(metrics?.generation).toBe(STATIC_GENERATION);
  expect(
    (metrics?.streetShardsFetched ?? 0) + (metrics?.streetShardsServed ?? 0),
  ).toBeGreaterThanOrEqual(1);
  expect(
    (metrics?.buildingShardsFetched ?? 0) + (metrics?.buildingShardsServed ?? 0),
  ).toBeGreaterThanOrEqual(1);

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.querySelector('[role="radiogroup"][aria-label="Route options"]')
              ?.textContent ?? "",
        ),
      { timeout: 30_000, message: "the subway option never reached the route list" },
    )
    .toContain("Via Subway");

  // The subway fixture's line is magenta; zero means the card describes a
  // journey the map is not drawing — the visible rendering path, transit included.
  await expect
    .poll(() => countTransitLinePixels(page), {
      timeout: 30_000,
      message: "the subway line never appeared on the map canvas",
    })
    .toBeGreaterThan(0);

  const live = traffic();
  expect(live.overpass.street).toBe(0);
  expect(
    live.overpass.building - preClick.building,
    "the subway calculation may not ask Overpass for buildings",
  ).toBe(0);
  expect(live.overpass.entrance).toBe(0);
  expect(live.shadow, "no _shadow request may occur").toBe(0);
  expect(live.maptilerStyle).toBeGreaterThan(0);
});

test("NYC transit: bus access/egress walks on the static graph", async ({ page }) => {
  const traffic = watchTraffic(page);
  await stubNetwork(page, {
    basemap: "fixture",
    transit: "scale-bus-only",
    navigation: "scale",
    overpass: "failRouting",
  });

  await page.goto(shareUrl(TRANSIT_A, TRANSIT_B));
  await waitForRoutableMap(page);

  await page
    .getByRole("button", { name: "Transit", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const routeLinePixelsBefore = await countRouteLinePixels(page);
  const preClick = traffic().overpass;
  await page.getByRole("button", { name: "Find Shadowed Route" }).click();
  await waitForRun(page);

  const metrics = await readNavigationMetrics(page);
  expect(metrics?.streetSource, "bus access/egress must walk the static graph").toBe("nyc-static");
  expect(metrics?.generation).toBe(STATIC_GENERATION);
  expect(
    (metrics?.streetShardsFetched ?? 0) + (metrics?.streetShardsServed ?? 0),
  ).toBeGreaterThanOrEqual(1);
  expect(
    (metrics?.buildingShardsFetched ?? 0) + (metrics?.buildingShardsServed ?? 0),
  ).toBeGreaterThanOrEqual(1);

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.querySelector('[role="radiogroup"][aria-label="Route options"]')
              ?.textContent ?? "",
        ),
      { timeout: 30_000, message: "the bus option never reached the route list" },
    )
    .toContain("Via Bus");

  // The bus fixture's corridor lines are not magenta, so the visual check is
  // the journey's drawn geometry: the selected transit route's walk legs reach
  // the canvas through the existing route-line source (the ride polylines use
  // the same trainDrawData pipeline the subway twin's magenta check already
  // proved end to end).
  await expect
    .poll(() => countRouteLinePixels(page), {
      timeout: 30_000,
      message: "the bus journey's geometry never appeared on the map canvas",
    })
    .toBeGreaterThan(routeLinePixelsBefore + 100);

  const live = traffic();
  expect(live.overpass.street).toBe(0);
  expect(
    live.overpass.building - preClick.building,
    "the bus calculation may not ask Overpass for buildings",
  ).toBe(0);
  expect(live.overpass.entrance).toBe(0);
  expect(live.shadow, "no _shadow request may occur").toBe(0);
  expect(live.maptilerStyle).toBeGreaterThan(0);
});

test("outside the verified support area, routing falls back to Overpass", async ({ page }) => {
  const traffic = watchTraffic(page);
  await stubNetwork(page, { basemap: "fixture", navigation: "scale", overpass: "failRouting" });

  await page.goto(shareUrl(OUTSIDE_A, OUTSIDE_B));
  await waitForRoutableMap(page);

  // The page-load prewarm fetches the in-viewport building shard (it is inside
  // support); scope the shard assertion to the calculation itself.
  const preClick = traffic();
  await page.getByRole("button", { name: "Find Shadowed Route" }).click();

  // The static selection declines (bbox outside the manifest's support), the
  // Overpass fallback fires and fails (it is refused in this scenario), and
  // the decline is observable — never a half-static or silent answer.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const m = (
            window as unknown as {
              __umbraMetrics?: { navigationDeclines?: { reason?: string | null }[] };
            }
          ).__umbraMetrics;
          return m?.navigationDeclines?.length ?? 0;
        }),
      { timeout: 60_000, message: "no navigation decline was ever recorded" },
    )
    .toBeGreaterThan(0);

  const decline = await page.evaluate(() => {
    const m = (
      window as unknown as {
        __umbraMetrics?: {
          navigationDeclines?: { streetSource?: string; reason?: string | null }[];
        };
      }
    ).__umbraMetrics;
    return m?.navigationDeclines?.[0] ?? null;
  });
  expect(decline?.streetSource).toBe("overpass");
  expect(decline?.reason).toBe("outside support");

  const live = traffic();
  expect(
    live.overpass.street,
    "the fallback must actually ask Overpass for streets",
  ).toBeGreaterThanOrEqual(1);
  expect(
    live.navigation.streets - preClick.navigation.streets,
    "the outside-support calculation may not fetch street shards",
  ).toBe(0);
  expect(
    live.navigation.buildings - preClick.navigation.buildings,
    "the outside-support calculation may not fetch building shards",
  ).toBe(0);
  expect(live.shadow, "no _shadow request may occur").toBe(0);
  expect(live.maptilerStyle).toBeGreaterThan(0);
});
