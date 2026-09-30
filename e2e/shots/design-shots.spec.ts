import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadEnv } from "vite";
import { SHARE_URL, stubNetwork, type Basemap } from "../helpers/scenario";

/**
 * Captures the app's key mobile UI states for design review. This is a shot run,
 * not a test: the assertions only herd the app into each state, the product is
 * the PNGs in out/shots/{day,night}/ (gitignored — throwaway iteration; curated shots are
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

for (const theme of ["day", "night"] as const) {
test(`Umbra mobile design states — ${theme}`, async ({ page }) => {
  await stubNetwork(page, { basemap: basemap() });
  // U6: the Foursquare typeahead is the one autocomplete path — a stubbed
  // places-search answer so the suggestion rows render in the shot.
  await page.route("**/api/fsq/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            fsq_id: "shot-library-1",
            name: "Jefferson Market Library",
            geocodes: { main: { latitude: 40.726, longitude: -74.005 } },
            categories: [{ name: "Library" }],
            hours: { display: "Open until 8 PM" },
            rating: 9.1,
            location: { formatted_address: "425 Ave of the Americas, New York" },
          },
          {
            fsq_id: "shot-library-2",
            name: "Dewey Square Reading Room",
            geocodes: { main: { latitude: 40.72, longitude: -74.0 } },
            categories: [{ name: "Reading Room" }],
            location: { formatted_address: "1 Hudson Sq, New York" },
          },
        ],
      }),
    })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SHARE_URL);
  // R1 preview seam. R2 will choose UI theme from selected solar time;
  // the basemap remains on its current day style until R4.
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-ground").trim()))
    .toBe(theme === "day" ? "#efe4d2" : "#0e0c0b");
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();

  const shot = (name: string) => async () => {
    const file = path.join(OUT, theme, name);
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
  // The selected card's detail block leaves the sheet scrolled; the U7 hero
  // (the split shade bar + duration verdict) lives on the card's verdict row,
  // so the committed shot starts from the top of the stack.
  await page.evaluate(() => {
    const sheet = document.querySelector("[data-testid='bottom-sheet']");
    const scroller = sheet?.querySelector("[class*='overflow']") ?? sheet;
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await shot("02-directions-cards.png")();

  // 2b. U7 — the arrival card: the peak-end shade story in the display voice
  // with the split bar. Ride the real phase FSM there (navigate → arrive),
  // then reopen directions so the choreography steps below still run.
  await page
    .getByRole("button", { name: "START NAVIGATING" })
    .filter({ visible: true })
    .first()
    .click();
  await page.waitForTimeout(800);
  await page
    .getByRole("button", { name: "ARRIVED" })
    .filter({ visible: true })
    .first()
    .click();
  await page.waitForTimeout(800);
  await shot("07-arrival.png")();
  await page
    .getByRole("button", { name: "Plan another" })
    .filter({ visible: true })
    .first()
    .click();
  await page.waitForTimeout(800);

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

  // 5. U6 typeahead — typing suggests Foursquare places with rich rows
  // (photo, category, hours, rating, distance); the dropdown shows them
  // before any submit.
  const searchBox = page
    .getByPlaceholder("Search destinations...")
    .filter({ visible: true })
    .first();
  await searchBox.fill("library");
  await page.waitForTimeout(1200); // debounce + stubbed typeahead round-trip
  await shot("05-typeahead.png")();

  // 6. Search results open — submit-triggered geocode (never autocomplete).
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
  const sheet = page.getByTestId("bottom-sheet");
  const sbox = await sheet.boundingBox().catch(() => null);
  if (sbox && sbox.height > 120) {
    await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + 20);
    await page.mouse.down();
    await page.mouse.move(sbox.x + sbox.width / 2, 830, { steps: 2 });
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
  await page.mouse.move(sx - 120, sy, { steps: 2 });
  await shot("06-timeline-dragging.png")();
  await page.mouse.up();

  console.log(`SHOTS_DONE ${path.join(OUT, theme)}`);
});
}
