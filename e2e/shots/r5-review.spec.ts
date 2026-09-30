import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loadEnv } from "vite";
import { SHARE_URL, START_TIME, TRANSIT_SHARE_URL, stubNetwork } from "../helpers/scenario";

// Run with R5_STAGE=before against the R4b preview, then R5_STAGE=after against the
// R5 preview; both builds need VITE_TRANSIT_BASE=https://transit.e2e.test for the
// transit card. Day is 09:00 and night 22:00 on Auto theme. `cards-*` is the sheet
// at its first (mid) snap, scrolled to the top; `details-*` raises the sheet to show
// the selected card's detail block; `transit-*` is the fixture subway trip.
const stage = process.env.R5_STAGE;
test.skip(stage !== "before" && stage !== "after", "R5 review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r5", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);

async function calculate(page: Page) {
  await page.getByRole("button", { name: "Find Shadowed Route" }).filter({ visible: true }).first().click();
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __umbraMetrics?: { latest?: unknown } }).__umbraMetrics?.latest)), {
      timeout: 60_000,
    })
    .toBe(true);
  await page.waitForTimeout(1500);
}

async function scrollSheet(page: Page, to: "top" | "bottom") {
  await page.evaluate((where) => {
    const sheet = document.querySelector("[data-testid='bottom-sheet']");
    const scroller = sheet?.querySelector("[class*='overflow']") ?? sheet;
    if (scroller instanceof HTMLElement) scroller.scrollTop = where === "top" ? 0 : scroller.scrollHeight;
  }, to);
  await page.waitForTimeout(300);
}

async function raiseSheet(page: Page) {
  const box = await page.getByTestId("bottom-sheet").boundingBox();
  if (!box) throw new Error("bottom sheet has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, 80, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`R5 review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.goto(SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(4000); // tiles, then the first shadow pass
    fs.mkdirSync(out, { recursive: true });

    await calculate(page);
    await scrollSheet(page, "top");
    await page.screenshot({ path: path.join(out, `cards-${theme}.png`) });

    await raiseSheet(page);
    await page.getByRole("radiogroup", { name: "Route options" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `details-${theme}.png`) });
    await scrollSheet(page, "bottom");
    await page.screenshot({ path: path.join(out, `details-end-${theme}.png`) });

    await page.goto(TRANSIT_SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "Transit", exact: true }).filter({ visible: true }).first().click();
    await calculate(page);
    await expect
      .poll(() => page.evaluate(() => document.querySelector('[role="radiogroup"][aria-label="Route options"]')?.textContent ?? ""), {
        timeout: 30_000,
      })
      .toContain("Via Subway");
    await page.getByRole("button", { name: /Via Subway/ }).filter({ visible: true }).first().click();
    await page.waitForTimeout(800);
    await raiseSheet(page);
    await page.getByRole("button", { name: /Via Subway/ }).filter({ visible: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `transit-${theme}.png`) });
  });
}
