import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import { makeDebugV2Fixtures } from "../app/lib/shadowV2Debug/__tests__/v2Fixtures";
import { stubNetwork } from "./helpers/scenario";

test("debug v2 stays quiet below z20 and outside coverage", async ({ page }) => {
  await stubNetwork(page, { basemap: "fixture" });
  const fixture = await makeDebugV2Fixtures("https://shadow.e2e.test");
  let smbRequests = 0;
  const bodies = new Map([[fixture.urls.current, fixture.pointer], [fixture.urls.root, fixture.root], [fixture.urls.coverage, fixture.coverage], [fixture.urls.tile, fixture.bundle]]);
  await page.route("https://shadow.e2e.test/**", async (route) => {
    if (route.request().url().endsWith(".smb")) smbRequests++;
    const body = bodies.get(route.request().url());
    await route.fulfill(body ? { status: 200, body: Buffer.from(body), contentType: route.request().url().endsWith(".json") ? "application/json" : "application/octet-stream" } : { status: 404 });
  });
  await page.goto("/?lat=20&lng=0&zoom=2");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect(page.getByTestId("shadow-v2-debug-panel")).toBeVisible();
  await expect.poll(() => smbRequests, { timeout: 10_000 }).toBe(0);

  // Zooming the out-of-coverage centre past z20 must still never acquire SMB.
  await page.locator("canvas.maplibregl-canvas").hover();
  await page.mouse.wheel(0, -12_000);
  await page.waitForTimeout(500);
  expect(smbRequests).toBe(0);

  // The fixture exposes exactly one member of the centred 3×3 neighbourhood.
  // At z20 the Worker leases only that member; the controller's request cap is
  // visible even when a browser serves a prior immutable bundle from CacheStorage.
  await page.goto("/?lat=40.73165&lng=-74.08768&z=20");
  await expect.poll(async () => (await page.getByTestId("shadow-v2-debug-panel").textContent())?.includes("requested 1"), { timeout: 20_000 }).toBe(true);
  expect(smbRequests).toBeLessThanOrEqual(9);
});
