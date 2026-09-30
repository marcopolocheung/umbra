import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadEnv } from "vite";
import { START_TIME, TRANSIT_SHARE_URL, stubNetwork } from "../helpers/scenario";

// #149 review: the fixture subway ride on the map with the sheet hidden, day 09:00 and
// night 22:00. BADGES_STAGE=before against main's preview, =after against this branch's;
// both builds need VITE_TRANSIT_BASE=https://transit.e2e.test.
const stage = process.env.BADGES_STAGE;
test.skip(stage !== "before" && stage !== "after", "transit badge capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/transit-badges", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`transit badges ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.goto(TRANSIT_SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "Transit", exact: true }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "Find Shadowed Route" }).filter({ visible: true }).first().click();
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as { __umbraMetrics?: { latest?: unknown } }).__umbraMetrics?.latest)), {
        timeout: 60_000,
      })
      .toBe(true);
    await page.waitForTimeout(2500);
    fs.mkdirSync(out, { recursive: true });
    await page.addStyleTag({ content: "[data-testid='bottom-sheet'] { visibility: hidden !important; }" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `map-${theme}.png`) });
  });
}
