import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loadEnv } from "vite";
import { CENTER, START_TIME, stubNetwork } from "../helpers/scenario";

// Run with R7A_STAGE=before against the main preview, then R7A_STAGE=after against the
// R7a preview. Day is 09:00 and night 22:00 on Auto theme, with no waypoints so the
// phone search pill shows. `focused-*` is the empty pill's Recent/Saved listing,
// `typeahead-*` the Foursquare suggestions while typing, `results-*` the merged
// listing after an explicit submit (Nominatim and Foursquare both stubbed here).
const stage = process.env.R7A_STAGE;
test.skip(stage !== "before" && stage !== "after", "R7a review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r7a", stage ?? "");
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
    class: "amenity",
    type: "library",
  },
  {
    display_name: "Library Way, Manhattan, New York, 10016, United States",
    lat: "40.7526",
    lon: "-73.9800",
    class: "highway",
    type: "residential",
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

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`R7a review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await stubSearch(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        "umbra:recentSearches",
        JSON.stringify([
          { label: "Bryant Park", center: [-73.9832, 40.7536], zoom: 16 },
          { label: "Grand Central Terminal", center: [-73.9772, 40.7527], zoom: 16 },
        ]),
      );
      localStorage.setItem(
        "umbra:savedPlaces",
        JSON.stringify([{ label: "Home", center: [-73.9911, 40.7484], zoom: 16 }]),
      );
    });
    await page.goto(url(time));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(4000);
    fs.mkdirSync(out, { recursive: true });

    const input = page.getByPlaceholder(/^Search/).filter({ visible: true }).first();
    await input.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `focused-${theme}.png`) });

    await input.fill("library");
    await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `typeahead-${theme}.png`) });

    await page.getByRole("button", { name: "Search", exact: true }).filter({ visible: true }).first().click();
    await expect(page.getByRole("option", { name: /Schwarzman/ })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `results-${theme}.png`) });

    if (stage === "before") return;
    // Desktop: the 376px pill carries menu and directions too, every target still 44px.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(800);
    await page.getByPlaceholder(/^Search/).filter({ visible: true }).first().fill("library");
    await page.getByRole("button", { name: "Search", exact: true }).filter({ visible: true }).first().click();
    await expect(page.getByRole("option", { name: /Schwarzman/ }).filter({ visible: true })).toBeVisible({ timeout: 10_000 });
    await page.mouse.move(900, 600);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `desktop-results-${theme}.png`), clip: { x: 0, y: 0, width: 640, height: 480 } });
  });
}
