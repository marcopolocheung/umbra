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

  // 1. Loaded scene — map, shadows, bottom sheet at rest.
  await expect
    .poll(() => page.locator("canvas.maplibregl-canvas").count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(2500); // let the first shadow pass settle
  await shot("01-initial.png")();

  // 2. Timeline engaged — the owner's second pain point, controls state.
  const slider = page.getByTestId("timeline-slider").filter({ visible: true });
  await expect(slider).toBeVisible();
  await shot("02-timeline.png")();

  // 3. Search focused — pain point three, entry state.
  await page.getByPlaceholder("Search destinations...").filter({ visible: true }).first().click();
  await page.waitForTimeout(600);
  await shot("03-search-focused.png")();

  // 4. Assistant open.
  await page.getByRole("button", { name: "Open Umbra Assistant" }).click();
  await expect(page.getByText("Umbra Assistant", { exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  await shot("04-assistant.png")();
  await page.getByTitle("Close", { exact: true }).filter({ visible: true }).click();

  // 5. Directions panel with calculated route — the owner's first pain point.
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
  await shot("05-route-cards.png")();

  // 6. Travel-mode selector engaged — component language sample.
  const travelSelector = page.getByTestId("travel-mode-selector").filter({ visible: true });
  await travelSelector.getByRole("button", { name: "Bike" }).click();
  await expect(travelSelector.getByRole("button", { name: "Bike" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.waitForTimeout(400);
  await shot("06-route-cards-bike.png")();

  console.log(`SHOTS_DONE ${OUT}`);
});
