import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadEnv } from "vite";
import { CENTER, START_TIME, stubNetwork } from "../helpers/scenario";

// Run with R8C_STAGE=before against the R8b preview, then R8C_STAGE=after against the
// R8c preview. Empty states at 390×844 in each forced UI theme: `idle-*` the idle sheet
// opened from its Trip pill, `desktop-idle-*` the 1280×800 sidebar,
// `search-empty-*` a submitted search that both providers answer with nothing (stubbed),
// `assistant-empty-*` the assistant before its first message.
const stage = process.env.R8C_STAGE;
test.skip(stage !== "before" && stage !== "after", "R8c review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r8c", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);
const URL = `/?lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}&date=2026-06-21&time=${START_TIME}`;

for (const theme of ["day", "night"] as const) {
  test(`R8c review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.route("**/api/fsq/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [] }) }),
    );
    await page.route("**/api/nominatim*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.addInitScript((value) => localStorage.setItem("umbra:uiTheme", value), theme);
    await page.goto(URL);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(3000);
    fs.mkdirSync(out, { recursive: true });

    await page.getByRole("button", { name: "Reopen trip panel" }).filter({ visible: true }).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `idle-${theme}.png`) });
    await page.goto(URL);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.waitForTimeout(2000);

    const search = page.getByPlaceholder(/^Search/).filter({ visible: true }).first();
    await search.fill("zzqx lane");
    await search.press("Enter");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, `search-empty-${theme}.png`) });
    await search.press("Escape");

    await page.getByRole("button", { name: "Open Umbra Assistant" }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(out, `assistant-empty-${theme}.png`) });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(URL);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(out, `desktop-idle-${theme}.png`), clip: { x: 0, y: 0, width: 640, height: 800 } });
  });
}
