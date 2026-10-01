import { expect, test } from "@playwright/test";
import { SHARE_URL, stubNetwork, WAYPOINT_A, WAYPOINT_B } from "./helpers/scenario";

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Umbra identity and migrated saved routes at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubNetwork(page, { basemap: "fixture" });
    await page.addInitScript(({ a, b }) => {
      if (localStorage.getItem("umbra:routes")) return;
      localStorage.setItem("shademapnav:routes", JSON.stringify([{
        id: "legacy-walk", name: "My shaded walk", folderId: null,
        waypointA: a, waypointB: b, waypointALabel: "Start", waypointBLabel: "Finish",
        additionalWaypoints: [], timeOfDayMinutes: 540, dateIso: "2026-06-21", createdAt: 123,
        routeOption: {
          label: "Most shaded", distanceM: 340, shadeCoverage: 0.75,
          longestContinuousShadeM: 100, longestContinuousSunM: 40, shadeTransitions: 2,
          detourRatio: 1, turnCount: 0,
          geojson: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [a, b] } },
        },
      }]));
      localStorage.setItem("shademapnav:shadeLegendDismissed", "1");
    }, { a: WAYPOINT_A, b: WAYPOINT_B });
    await page.goto(SHARE_URL);
    await expect(page).toHaveTitle(/Umbra/);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    if (viewport.width < 768) {
      // A shared trip opens Directions on phones, which hides the search pill.
      await expect(page.getByRole("button", { name: "Hide interface" })).toBeHidden();
      await page.getByTitle("Back", { exact: true }).filter({ visible: true }).click();
    }
    await page.getByRole("button", { name: "Open Umbra Assistant" }).click();
    await expect(page.getByText("Umbra Assistant", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Ask about shadow, routes, or a day trip…")).toBeVisible();
    // The icon button's accessible name is its Material ligature ("close"), so
    // target the tooltip the rebrand actually renames.
    await page.getByTitle("Close", { exact: true }).filter({ visible: true }).click();
    if (viewport.width < 768) await page.goto(SHARE_URL);
    // A saved route keeps this section collapsed at the first sheet snap point.
    await page.getByRole("button", { name: /Saved routes\s*1/i }).filter({ visible: true }).click();
    // Anchored: the ticket's rename and delete controls carry the name too.
    const legacyRoute = page.getByRole("button", { name: /^My shaded walk/ }).filter({ visible: true });
    await expect(legacyRoute).toContainText("75% shadow");
    await legacyRoute.click();
    await expect(page.getByText("Most shadowed", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("shademapnav:routes"))).toBeNull();
    await page.screenshot({ path: `test-results/umbra-${viewport.width}.png` });
    await page.goto("/about");
    await expect(page.getByRole("heading", { name: "Umbra", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "mapbox-gl-shadow-simulator" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("unaffiliated");
    await page.screenshot({ path: `test-results/umbra-about-${viewport.width}.png` });
  });
}

test.describe("service-worker compatibility", () => {
  test.use({ serviceWorkers: "allow" });
  test("activation replaces the legacy cached application shell", async ({ page, context }) => {
    // Start on a static resource so no application worker has registered yet.
    await page.goto("/manifest.webmanifest");
    await page.evaluate(async () => {
      const cache = await caches.open("shademapnav-shell-v1");
      await cache.put("/", new Response("<title>ShadeMapNav</title>old shell"));
      await cache.put("/obsolete.js", new Response("old code"));
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual(["umbra-shell-v3"]);
    const shell = await page.evaluate(async () => (await (await caches.open("umbra-shell-v3")).match("/"))?.text());
    expect(shell).toContain("Umbra");
    expect(await page.evaluate(async () => !!(await caches.match("/fonts/jost-variable.woff2")))).toBe(true);
    expect(await page.evaluate(async () => !!(await caches.match("/obsolete.js")))).toBe(false);
    await context.setOffline(true);
    await page.goto("/");
    await expect(page).toHaveTitle(/Umbra/);
  });
});
