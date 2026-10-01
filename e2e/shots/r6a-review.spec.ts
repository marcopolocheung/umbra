import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loadEnv } from "vite";
import { SHARE_URL, START_TIME, stubNetwork } from "../helpers/scenario";

// Run with R6A_STAGE=before against the main preview, then R6A_STAGE=after against the
// R6a preview. Day is 09:00 and night 22:00 on Auto theme. `timeline-*` is the idle map
// with the sheet collapsed, `dragging-*` the ruler mid-drag, `day-of-year-*` the
// calendar ruler.
const stage = process.env.R6A_STAGE;
test.skip(stage !== "before" && stage !== "after", "R6a review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r6a", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);

async function collapseSheet(page: Page) {
  const box = await page.getByTestId("bottom-sheet").boundingBox();
  if (!box || box.height <= 120) return;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, 830, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`R6a review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.goto(SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(4000);
    fs.mkdirSync(out, { recursive: true });

    await collapseSheet(page);
    await page.screenshot({ path: path.join(out, `timeline-${theme}.png`) });

    const slider = page.getByTestId("timeline-slider").filter({ visible: true });
    const box = await slider.boundingBox();
    if (!box) throw new Error("timeline slider has no layout box");
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 120, sy, { steps: 2 });
    await page.screenshot({ path: path.join(out, `dragging-${theme}.png`) });
    await page.mouse.up();
    await page.waitForTimeout(800);

    await page.getByTitle("Switch to day of year").filter({ visible: true }).first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `day-of-year-${theme}.png`) });
  });
}
