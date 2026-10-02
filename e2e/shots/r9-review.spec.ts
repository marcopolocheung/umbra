import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CENTER, START_TIME, stubNetwork } from "../helpers/scenario";

const folder = "docs/design/shots/r9/after";
mkdirSync(folder, { recursive: true });

for (const theme of ["day", "night"] as const) {
  for (const viewport of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 900 }]) {
    test(`R9 About poster: ${theme} ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/about");
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("heading", { level: 1, name: "Umbra." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "The field key" })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: join(folder, `${viewport.name}-${theme}.png`), fullPage: true });
    });
  }
}

// Opt-in capture for the live map surfaces. Run against main on port 4175 with
// R9_MAP_STAGE=before, then this branch with R9_MAP_STAGE=after.
const mapStage = process.env.R9_MAP_STAGE;
for (const theme of ["day", "night"] as const) {
  test(`R9 planning controls: ${theme}`, async ({ page }) => {
    test.skip(mapStage !== "before" && mapStage !== "after", "R9 map capture is opt-in");
    await stubNetwork(page, { basemap: "fixture" });
    await page.addInitScript((value) => localStorage.setItem("umbra:uiTheme", value), theme);
    const origin = mapStage === "before" ? "http://127.0.0.1:4175" : "";
    await page.goto(`${origin}/?lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}&date=2026-06-21&time=${START_TIME}`);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.getByRole("button", { name: "Reopen trip panel" }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "Directions", exact: true }).filter({ visible: true }).first().click();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1800);
    if (mapStage === "after") await expect(page.locator(".directions-tag svg").filter({ visible: true })).toHaveCount(2);
    const out = `docs/design/shots/r9/${mapStage}`;
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: join(out, `planning-${theme}.png`) });
  });
}
