import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CENTER, START_TIME, stubNetwork } from "../helpers/scenario";

// The same grounded two-place turn runs against the R7b and R7c preview builds.
// Nominatim supplies place evidence; the model only chooses a search and names
// those results. The application plots and verifies the numbered receipts.
const stage = process.env.R7C_STAGE;
test.skip(stage !== "before" && stage !== "after", "R7c review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r7c", stage ?? "");
const url = `/?lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}&date=2026-06-21&time=${START_TIME}`;
const places = [
  { display_name: "Bryant Park, Manhattan, New York", lat: "40.7536", lon: "-73.9832" },
  { display_name: "Grace Plaza, Manhattan, New York", lat: "40.7520", lon: "-73.9850" },
];

async function stubAssistant(page: Page) {
  await page.route("**/api/nominatim*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(places),
  }));
  let calls = 0;
  await page.route("**/api/agent", (route) => {
    calls++;
    const message = calls === 1
      ? { role: "assistant", content: null, tool_calls: [{
          id: "search-1", type: "function",
          function: { name: "search_places", arguments: JSON.stringify({ query: "parks" }) },
        }] }
      : { role: "assistant", content: "Bryant Park and Grace Plaza are on the map." };
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ choices: [{ message, finish_reason: calls === 1 ? "tool_calls" : "stop" }] }),
    });
  });
}

for (const theme of ["day", "night"] as const) {
  test(`R7c review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: "fixture" });
    await stubAssistant(page);
    await page.addInitScript((value) => localStorage.setItem("umbra:uiTheme", value), theme);
    await page.goto(url);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    fs.mkdirSync(out, { recursive: true });

    await page.getByRole("button", { name: "Open Umbra Assistant" }).click();
    await page.getByPlaceholder("Ask about shadow, routes, or a day trip…").fill("Show me two places to sit near the map");
    await page.getByRole("button", { name: /send/i }).click();
    if (stage === "before") {
      await expect(page.getByRole("button", { name: /Bryant Park, Manhattan — located/ })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: /Grace Plaza, Manhattan — located/ })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: /Focus stop 1 on map: Bryant Park, Manhattan — located/ })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: /Focus stop 2 on map: Grace Plaza, Manhattan — located/ })).toBeVisible();
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(out, `assistant-${theme}.png`) });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `desktop-assistant-${theme}.png`) });
    if (stage === "after") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /Focus stop 2 on map: Grace Plaza/ }).click();
      await expect(page.getByRole("button", { name: /Stop 2: Grace Plaza/ })).toBeVisible();
      await expect(page.getByRole("region", { name: "Umbra Assistant" })).toHaveCount(0);
    }
  });
}
