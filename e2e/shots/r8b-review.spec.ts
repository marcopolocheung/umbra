import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loadEnv } from "vite";
import { SHARE_URL, WAYPOINT_A, WAYPOINT_B, stubNetwork } from "../helpers/scenario";

// Run with R8B_STAGE=before against the R8a preview, then R8B_STAGE=after against the
// R8b preview. Three v1 saved routes are seeded (a sun walk, a rain walk with unknown
// shelter, and a sun walk in a folder) and the Saved routes section is opened in the
// directions sheet: `saved-*` at the phone's mid snap, `saved-full-*` with the sheet
// raised, `desktop-saved-*` the sidebar.
const stage = process.env.R8B_STAGE;
test.skip(stage !== "before" && stage !== "after", "R8b review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r8b", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);

const line = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [WAYPOINT_A, WAYPOINT_B] } };
const route = (id: string, name: string, extra: Record<string, unknown>, folderId: string | null = null) => ({
  id,
  name,
  folderId,
  routeOption: {
    label: "Shortest",
    geojson: line,
    longestContinuousShadowM: 0,
    longestContinuousSunM: 0,
    shadowTransitions: 0,
    detourRatio: 1,
    turnCount: 0,
    ...extra,
  },
  waypointA: WAYPOINT_A,
  waypointB: WAYPOINT_B,
  waypointALabel: null,
  waypointBLabel: "Bryant Park",
  additionalWaypoints: [],
  timeOfDayMinutes: 9 * 60,
  dateIso: "2026-06-21",
  createdAt: 1,
});
const ROUTES = [
  route("r1", "Library to Bryant Park", { distanceM: 840, shadowCoverage: 0.62 }),
  route("r2", "Rainy errand", { distanceM: 1260, shadowCoverage: 0, dryCoverage: 0.48 }),
  route("r3", "Morning coffee", { distanceM: 410, shadowCoverage: 0.31 }, "f1"),
];
const FOLDERS = [{ id: "f1", name: "Weekdays", createdAt: 1 }];

async function openSaved(page: Page) {
  const toggle = page.getByRole("button", { name: /Saved routes/i }).filter({ visible: true }).first();
  await toggle.click();
  await page.waitForTimeout(500);
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

for (const theme of ["day", "night"] as const) {
  test(`R8b review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.addInitScript(
      ([value, routes, folders]) => {
        localStorage.setItem("umbra:uiTheme", value);
        localStorage.setItem("umbra:routes", routes);
        localStorage.setItem("umbra:folders", folders);
      },
      [theme, JSON.stringify(ROUTES), JSON.stringify(FOLDERS)] as const,
    );
    await page.goto(SHARE_URL);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(3000);
    fs.mkdirSync(out, { recursive: true });

    await openSaved(page);
    await page.screenshot({ path: path.join(out, `saved-${theme}.png`) });
    await raiseSheet(page);
    await page.screenshot({ path: path.join(out, `saved-full-${theme}.png`) });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SHARE_URL);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.waitForTimeout(3000);
    await openSaved(page);
    await page.screenshot({ path: path.join(out, `desktop-saved-${theme}.png`), clip: { x: 0, y: 0, width: 640, height: 800 } });
  });
}
