import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loadEnv } from "vite";
import { SHARE_URL, START_TIME, stubNetwork } from "../helpers/scenario";

// Run with R6B_STAGE=before against the main preview, then R6B_STAGE=after against the
// R6b preview. Day is 09:00 and night 22:00 on Auto theme. `routes-*` is the top of the
// raised sheet (its edge, the solar pill and the route stack); `board-*` the selected card's hourly
// board scrolled into view once every hour is sampled (after only: on main the phone
// sheet never rendered the strip).
const stage = process.env.R6B_STAGE;
test.skip(stage !== "before" && stage !== "after", "R6b review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r6b", stage ?? "");
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

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`R6b review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.goto(SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(4000);
    fs.mkdirSync(out, { recursive: true });

    await page.getByRole("button", { name: "Find the shade" }).filter({ visible: true }).first().click();
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as { __umbraMetrics?: { latest?: unknown } }).__umbraMetrics?.latest)), {
        timeout: 60_000,
      })
      .toBe(true);
    await page.waitForTimeout(1500);
    await raiseSheet(page);
    const sheet = page.getByTestId("bottom-sheet");
    await sheet.locator(":scope > div.flex-1").evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `routes-${theme}.png`) });

    if (stage === "before") return;
    await expect(sheet.getByText(/most shadowed around/i)).toBeVisible({ timeout: 30_000 });
    // Centred, so the sticky Start Navigating bar never covers the board.
    await sheet.getByText(/^Sun by hour$/i).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `board-${theme}.png`) });
  });
}
