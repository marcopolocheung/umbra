import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loadEnv } from "vite";
import { CENTER, START_TIME, stubNetwork } from "../helpers/scenario";

// Run with R7B_STAGE=before against the R7a preview, then R7B_STAGE=after against the
// R7b preview. Picking a place resets the time to now (useShadowTime.jumpTo), so the UI
// theme is forced through the persisted Settings override. A Foursquare place is picked
// from the search directory: `place-*` is the phone sheet at its mid snap, `place-full-*`
// the sheet raised, `desktop-place-*` the sidebar (Nominatim and Foursquare stubbed).
const stage = process.env.R7B_STAGE;
test.skip(stage !== "before" && stage !== "after", "R7b review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r7b", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);
const url = (time: string) => `/?lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}&date=2026-06-21&time=${time}`;

const FSQ = {
  results: [
    {
      fsq_id: "shot-library-1",
      name: "Mid-Manhattan Library",
      geocodes: { main: { latitude: 40.7526, longitude: -73.9817 } },
      categories: [{ name: "Library" }],
      hours: { display: "Open until 8 PM" },
      rating: 9.1,
      location: { formatted_address: "455 5th Ave, New York" },
    },
    {
      fsq_id: "shot-library-2",
      name: "Library Hotel",
      geocodes: { main: { latitude: 40.7517, longitude: -73.9799 } },
      categories: [{ name: "Hotel" }],
      location: { formatted_address: "299 Madison Ave, New York" },
    },
    {
      fsq_id: "shot-library-3",
      name: "Morgan Library & Museum",
      geocodes: { main: { latitude: 40.7492, longitude: -73.9814 } },
      categories: [{ name: "Museum" }],
      hours: { display: "Closed" },
      rating: 9.4,
      location: { formatted_address: "225 Madison Ave, New York" },
    },
  ],
};

const NOMINATIM = [
  {
    display_name: "Stephen A. Schwarzman Building, 476, 5th Avenue, Manhattan, New York, 10018, United States",
    lat: "40.7532",
    lon: "-73.9822",
    boundingbox: ["40.7525", "40.7539", "-73.9830", "-73.9813"],
  },
  {
    display_name: "Library Way, Manhattan, New York, 10016, United States",
    lat: "40.7526",
    lon: "-73.9800",
  },
];

async function stubSearch(page: Page) {
  await page.route("**/api/fsq/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FSQ) }),
  );
  await page.route("**/api/nominatim*", (route) => {
    const isReverse = new URL(route.request().url()).searchParams.get("endpoint") === "reverse";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(isReverse ? { display_name: "Test Street, Test City" } : NOMINATIM),
    });
  });
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

async function pickPlace(page: Page) {
  await page.getByPlaceholder(/^Search/).filter({ visible: true }).first().fill("library");
  const option = page.getByRole("option", { name: /Mid-Manhattan Library/ }).filter({ visible: true });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
  // Picking sets the query to the place's name, which re-arms the typeahead a beat
  // later; close it so the shot shows the entry, not a second dropdown.
  await page.waitForTimeout(800);
  await page.getByPlaceholder(/^Search/).filter({ visible: true }).first().press("Escape");
  await page.mouse.move(1, 400);
  await page.waitForTimeout(1500);
}

for (const theme of ["day", "night"] as const) {
  test(`R7b review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await stubSearch(page);
    await page.addInitScript((value) => localStorage.setItem("umbra:uiTheme", value), theme);
    await page.goto(url(START_TIME));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(4000);
    fs.mkdirSync(out, { recursive: true });

    await pickPlace(page);
    await page.screenshot({ path: path.join(out, `place-${theme}.png`) });
    await raiseSheet(page);
    await page.screenshot({ path: path.join(out, `place-full-${theme}.png`) });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(800);
    await pickPlace(page);
    const openPanel = page.getByRole("button", { name: "Open panel" });
    if (await openPanel.count()) {
      await openPanel.click();
      await page.waitForTimeout(800);
    }
    await page.screenshot({ path: path.join(out, `desktop-place-${theme}.png`), clip: { x: 0, y: 0, width: 640, height: 800 } });
  });
}
