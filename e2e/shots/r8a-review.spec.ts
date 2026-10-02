import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loadEnv } from "vite";
import { CENTER, WAYPOINT_A, WAYPOINT_B, stubNetwork } from "../helpers/scenario";

// Run with R8A_STAGE=before against the R7 preview, then R8A_STAGE=after against the
// R8a preview. Each case rides the real phase FSM to the arrival card (find → start →
// ARRIVED): `arrival-{day,night}` is the 09:00 trip under each forced UI theme,
// `arrival-sunset` the same trip at 22:00 (sun down where it was routed), and
// `desktop-arrival-*` the sidebar.
const stage = process.env.R8A_STAGE;
test.skip(stage !== "before" && stage !== "after", "R8a review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r8a", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);
const url = (time: string) =>
  `/?lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}&date=2026-06-21&time=${time}` +
  `&a=${WAYPOINT_A[0]},${WAYPOINT_A[1]}&b=${WAYPOINT_B[0]},${WAYPOINT_B[1]}`;

const visible = (page: Page, name: string) =>
  page.getByRole("button", { name }).filter({ visible: true }).first();

async function arrive(page: Page) {
  await visible(page, "Find the shade").click();
  await expect
    .poll(
      () => page.evaluate(() => Boolean((window as unknown as { __umbraMetrics?: { latest?: unknown } }).__umbraMetrics?.latest)),
      { timeout: 40_000 },
    )
    .toBe(true);
  await page.waitForTimeout(1200);
  await visible(page, "START NAVIGATING").click();
  await page.waitForTimeout(800);
  await visible(page, "ARRIVED").click();
  await page.waitForTimeout(1200);
}

const CASES = [
  { name: "day", theme: "day", time: "09:00" },
  { name: "night", theme: "night", time: "09:00" },
  { name: "sunset", theme: "night", time: "22:00" },
] as const;

for (const c of CASES) {
  test(`R8a review ${c.name}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.addInitScript((value) => localStorage.setItem("umbra:uiTheme", value), c.theme);
    await page.goto(url(c.time));
    await expect(page.locator("html")).toHaveAttribute("data-theme", c.theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(3000);
    fs.mkdirSync(out, { recursive: true });

    await arrive(page);
    await page.screenshot({ path: path.join(out, `arrival-${c.name}.png`) });
    if (c.name === "sunset") return;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url(c.time));
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.waitForTimeout(3000);
    await arrive(page);
    await page.screenshot({ path: path.join(out, `desktop-arrival-${c.name}.png`), clip: { x: 0, y: 0, width: 640, height: 800 } });
  });
}
