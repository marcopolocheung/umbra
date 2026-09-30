import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loadEnv } from "vite";
import { SHARE_URL, START_TIME, TRANSIT_SHARE_URL, stubNetwork } from "../helpers/scenario";

// Run with R5B_STAGE=before against the R5a preview, then R5B_STAGE=after against the
// R5b preview; both builds need VITE_TRANSIT_BASE=https://transit.e2e.test. Day is
// 09:00 and night 22:00 on Auto theme. `form-*` is the planning form on the raised
// sheet; `navigating-*` the walk in NAVIGATING; `nav-transit-*` the fixture subway trip.
const stage = process.env.R5B_STAGE;
test.skip(stage !== "before" && stage !== "after", "R5b review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r5b", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);

async function raiseSheet(page: Page) {
  const box = await page.getByTestId("bottom-sheet").boundingBox();
  if (!box) throw new Error("bottom sheet has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, 80, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}

async function calculateAndNavigate(page: Page) {
  await page.getByRole("button", { name: "Find Shadowed Route" }).filter({ visible: true }).first().click();
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __umbraMetrics?: { latest?: unknown } }).__umbraMetrics?.latest)), {
      timeout: 60_000,
    })
    .toBe(true);
  await page.waitForTimeout(1500);
}

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`R5b review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.goto(SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(4000);
    fs.mkdirSync(out, { recursive: true });

    await raiseSheet(page);
    await page.screenshot({ path: path.join(out, `form-${theme}.png`) });

    await calculateAndNavigate(page);
    await page.getByRole("button", { name: "START NAVIGATING" }).filter({ visible: true }).first().click();
    await page.waitForTimeout(800);
    await raiseSheet(page);
    await page.screenshot({ path: path.join(out, `navigating-${theme}.png`) });

    await page.goto(TRANSIT_SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "Transit", exact: true }).filter({ visible: true }).first().click();
    await calculateAndNavigate(page);
    await page.getByRole("button", { name: /Via Subway/ }).filter({ visible: true }).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "START NAVIGATING" }).filter({ visible: true }).first().click();
    await page.waitForTimeout(800);
    await raiseSheet(page);
    await page.screenshot({ path: path.join(out, `nav-transit-${theme}.png`) });
  });
}
