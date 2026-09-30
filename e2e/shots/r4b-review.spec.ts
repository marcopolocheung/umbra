import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadEnv } from "vite";
import { SHARE_URL, START_TIME, stubNetwork } from "../helpers/scenario";

// Run with R4B_STAGE=before against the R4a preview, then R4B_STAGE=after against the
// R4b preview. The seeded walk is calculated at 09:00 (day basemap) and 22:00 (night),
// Auto theme, real MapTiler tiles when a key is present. `map-*` hides the sheet so
// the route, its casing and the A/B pins (DOM markers, not canvas) show over the map.
const stage = process.env.R4B_STAGE;
test.skip(stage !== "before" && stage !== "after", "R4b review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r4b", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`R4b review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.goto(SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(4000); // tiles, then the first shadow pass

    await page.getByRole("button", { name: "Find Shadowed Route" }).filter({ visible: true }).first().click();
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as { __umbraMetrics?: { latest?: unknown } }).__umbraMetrics?.latest)), {
        timeout: 40_000,
      })
      .toBe(true);
    await page.waitForTimeout(1500);

    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `app-${theme}.png`) });
    await page.addStyleTag({ content: "[data-testid='bottom-sheet'] { visibility: hidden !important; }" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `map-${theme}.png`) });
  });
}
