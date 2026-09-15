import { expect, test } from "@playwright/test";
import {
  countRouteLinePixels,
  maskDiff,
  sampleMapCanvas,
  shadowMask,
  shadowedFraction,
} from "./helpers/map";
import {
  type Basemap,
  DRAG_MINUTES,
  DRAG_PX_PER_MIN,
  INERTIA_CUTOFF_MS,
  SAMPLE_STEP,
  SHARE_URL,
  START_MINUTES,
  stubNetwork,
} from "./helpers/scenario";

/**
 * The one test that runs this app in a browser.
 *
 * It runs twice over, as two projects:
 *
 * - **`smoke`** serves a synthetic basemap style (`fixtures/basemapStyle.ts`) in
 *   place of MapTiler's, so it needs no API key and runs on every PR, forks
 *   included. It covers the WebGL shadow path, the timeline and routing.
 * - **`smoke-live`** runs the same assertions against real MapTiler vector
 *   tiles, and only when a key is present. It exists because the fixture cannot
 *   prove one thing the live tiles can: that the app still parses MapTiler's
 *   actual `building` schema. If MapTiler renames `render_height`, only this
 *   project notices.
 */
test("loads, paints shadows, retimes them, and renders a calculated route", async ({ page }, testInfo) => {
  const basemap: Basemap = testInfo.project.name === "smoke-live" ? "live" : "fixture";
  await stubNetwork(page, { basemap });

  await page.goto(SHARE_URL);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();

  // 1. Shadows paint. Poll rather than wait a fixed time: tile fetches and the
  //    first shadow pass are both slower under SwiftShader than on a GPU.
  await expect
    .poll(
      async () => shadowedFraction(shadowMask(await sampleMapCanvas(page, SAMPLE_STEP))),
      { timeout: 90_000, message: "no blue-dominant shadow pixels ever appeared on the map" }
    )
    .toBeGreaterThan(0.02);

  // Let the field settle before it becomes the reference frame: a half-finished
  // first shadow pass would otherwise read as the drag's doing.
  let morningMask = shadowMask(await sampleMapCanvas(page, SAMPLE_STEP));
  await expect
    .poll(
      async () => {
        const next = shadowMask(await sampleMapCanvas(page, SAMPLE_STEP));
        const drift = maskDiff(morningMask, next);
        morningMask = next;
        return drift;
      },
      { timeout: 15_000, message: "the shadow field never stopped changing on its own" }
    )
    .toBeLessThan(0.005);

  // 2. Dragging the timeline moves the shadows. Compare masks, not totals: at a
  //    different hour the same *amount* of shadow can fall somewhere else.
  // The desktop and mobile layouts each mount a timeline; only one is displayed
  // at this viewport.
  const slider = page.getByTestId("timeline-slider").filter({ visible: true });
  await expect(slider).toBeVisible();
  const box = await slider.boundingBox();
  if (!box) throw new Error("timeline slider has no layout box");
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX - DRAG_MINUTES * DRAG_PX_PER_MIN, y, { steps: 12 });
  // Pause before releasing. TimelineSlider launches momentum only when the
  // pointer comes up within 80 ms of the last move, and a flung slider coasts
  // for an unpredictable number of minutes — which would make the end time a
  // function of how fast the machine running the test happens to be.
  await page.waitForTimeout(INERTIA_CUTOFF_MS * 2);
  await page.mouse.up();

  // The app mirrors date and time back into the URL on every change, so this is
  // the clock the drag actually landed on. ±2 min absorbs per-frame rounding.
  await expect
    .poll(
      () => {
        const [h, m] = (new URL(page.url()).searchParams.get("time") ?? "0:0")
          .split(":")
          .map(Number);
        return Math.abs(h * 60 + m - (START_MINUTES + DRAG_MINUTES));
      },
      { timeout: 10_000, message: "the drag did not land on the expected clock time" }
    )
    .toBeLessThanOrEqual(2);

  await expect
    .poll(async () => maskDiff(morningMask, shadowMask(await sampleMapCanvas(page, SAMPLE_STEP))), {
      timeout: 20_000,
      message: "the shadow field did not change after dragging the timeline",
    })
    .toBeGreaterThan(0.01);

  // 3. A two-point route calculates and its line reaches the canvas. The share
  //    link already seeded both waypoints and opened the directions panel.
  const routeLinePixelsBefore = await countRouteLinePixels(page);
  await page.getByRole("button", { name: "Find Shadowed Route" }).click();

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const metrics = (window as unknown as { __umbraMetrics?: { latest?: unknown } })
            .__umbraMetrics;
          return Boolean(metrics?.latest);
        }),
      { timeout: 40_000, message: "no routing run was ever recorded on window.__umbraMetrics" }
    )
    .toBe(true);

  await expect
    .poll(() => countRouteLinePixels(page), {
      timeout: 20_000,
      message: "the route line never appeared on the map canvas",
    })
    .toBeGreaterThan(routeLinePixelsBefore + 200);

  // 4. The Walk/Bike/Scoot travel selector (E1/E4) syncs to the share URL. The desktop
  //    and mobile layouts each mount a directions panel; only one is displayed
  //    at this viewport.
  const travelSelector = page.getByTestId("travel-mode-selector").filter({ visible: true });
  await expect(travelSelector.getByRole("button", { name: "Bike" })).toBeVisible();
  await travelSelector.getByRole("button", { name: "Bike" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("mode"), {
      timeout: 10_000,
      message: "picking Bike did not persist mode=bike to the share URL",
    })
    .toBe("bike");
  await expect(travelSelector.getByRole("button", { name: "Bike" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await travelSelector.getByRole("button", { name: "Walk" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("mode"), {
      timeout: 10_000,
      message: "picking Walk did not clear mode from the share URL",
    })
    .toBeNull();

  // 5. The Scoot travel selector (E4) syncs to the share URL and fits its row.
  await travelSelector.getByRole("button", { name: "Scoot" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("mode"), {
      timeout: 10_000,
      message: "picking Scoot did not persist mode=scoot to the share URL",
    })
    .toBe("scoot");
  await expect(travelSelector.getByRole("button", { name: "Scoot" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(
      () =>
        travelSelector.evaluate(
          (el) => el.scrollWidth <= el.clientWidth + 1,
        ),
      { timeout: 10_000, message: "the three travel buttons overflow their row" },
    )
    .toBe(true);
  await travelSelector.getByRole("button", { name: "Walk" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("mode"), {
      timeout: 10_000,
      message: "leaving Scoot did not clear mode from the share URL",
    })
    .toBeNull();
});
