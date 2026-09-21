import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadEnv } from "vite";
import { SHARE_URL, stubNetwork, type Basemap } from "../helpers/scenario";

/**
 * Captures the app's key mobile UI states for design review. This is a shot run,
 * not a test: the assertions only herd the app into each state, the product is
 * the PNGs in out/shots/ (gitignored — throwaway iteration; curated shots are
 * committed under docs/design/shots/u<n>/ by the session).
 *
 * Basemap: real MapTiler tiles when a key is present (the design must be judged
 * on the real map), the synthetic smoke fixture otherwise. Override with
 * SHOTS_BASEMAP=fixture to force the keyless look.
 */
function basemap(): Basemap {
  if (process.env.SHOTS_BASEMAP === "fixture") return "fixture";
  const key = loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY;
  return key ? "live" : "fixture";
}

const OUT = process.env.SHOTS_OUT ?? path.join(process.cwd(), "out", "shots");

test("Umbra mobile design states", async ({ page }) => {
  await stubNetwork(page, { basemap: basemap() });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SHARE_URL);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();

  const shot = (name: string) => async () => {
    const file = path.join(OUT, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    console.log(`SHOT ${file}`);
  };

  // 1. Loaded scene — share link, shadows painting, sheet at mid with the
  // planning form. During DIRECTIONS the mobile search pill is hidden (U4):
  // this shot is the "directions over search" proof.
  await expect
    .poll(() => page.locator("canvas.maplibregl-canvas").count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(2500); // let the first shadow pass settle
  await shot("01-directions-no-search.png")();

  // Calculate the seeded trip so the sheet shows the trip bar + cards.
  await page
    .getByRole("button", { name: "Find Shadowed Route" })
    .filter({ visible: true })
    .first()
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const metrics = (window as unknown as { __umbraMetrics?: { latest?: unknown } })
            .__umbraMetrics;
          return Boolean(metrics?.latest);
        }),
      { timeout: 40_000, message: "no routing run was ever recorded on window.__umbraMetrics" },
    )
    .toBe(true);
  await page.waitForTimeout(1200);
  await shot("02-directions-cards.png")();

  // 3. Back out to IDLE — the search pill returns (the choreography closes
  // the loop; no ambiguous half-slid search over the card).
  const back = page.getByTitle("Back", { exact: true }).filter({ visible: true }).first();
  await back.click();
  await page.waitForTimeout(800);
  await shot("03-idle-search-returned.png")();

  // 4. Search focused — entry state.
  await page.getByPlaceholder("Search destinations...").filter({ visible: true }).first().click();
  await page.waitForTimeout(600);
  await shot("04-search-focused.png")();

  // 5. Search results open — submit-triggered geocode (never autocomplete).
  await page.getByPlaceholder("Search destinations...").filter({ visible: true }).first().fill("library");
  await page
    .getByRole("button", { name: "Search", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await shot("05-search-results.png")();
  await page.keyboard.press("Escape");

  // 6. Timeline dragging — collapse the sheet, grab the slider mid-drag with
  // the sun-arc dot live.
  const sheet = page.locator("div.fixed.bottom-0");
  const sbox = await sheet.boundingBox().catch(() => null);
  if (sbox && sbox.height > 120) {
    await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + 20);
    await page.mouse.down();
    await page.mouse.move(sbox.x + sbox.width / 2, 830, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
  const slider = page.getByTestId("timeline-slider").filter({ visible: true });
  const box = await slider.boundingBox();
  if (!box) throw new Error("timeline slider has no layout box");
  const sx = box.x + box.width / 2;
  const sy = Math.min(box.y + box.height / 2, 843);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx - 120, sy, { steps: 8 });
  await shot("06-timeline-dragging.png")();
  await page.mouse.up();

  console.log(`SHOTS_DONE ${OUT}`);
});
