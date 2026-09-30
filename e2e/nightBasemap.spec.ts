import { expect, test } from "@playwright/test";
import { sampleMapCanvas, shadowedFraction, shadowMask } from "./helpers/map";
import { SAMPLE_STEP, SHARE_URL, START_TIME, stubNetwork } from "./helpers/scenario";

test("solar night clears its overlay while rain protection and routing stay active", async ({ page }, testInfo) => {
  await stubNetwork(page, { basemap: testInfo.project.name === "smoke-live" ? "live" : "fixture" });
  await page.goto(SHARE_URL.replace(`time=${START_TIME}`, "time=22:00"));
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  const mode = page.getByTestId("rain-mode-selector").filter({ visible: true });
  await expect(mode).toBeVisible();

  await expect.poll(async () => shadowedFraction(shadowMask(await sampleMapCanvas(page, SAMPLE_STEP))), {
    timeout: 90_000, message: "solar night retained blue protection pixels",
  }).toBeLessThan(0.002);
  await expect(page.getByText("Dark blue areas are shadowed at the selected time.")).toHaveCount(0);

  await mode.getByRole("button", { name: "Rain" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await expect.poll(async () => shadowedFraction(shadowMask(await sampleMapCanvas(page, SAMPLE_STEP))), {
    timeout: 90_000, message: "nighttime rain protection never appeared",
  }).toBeGreaterThan(0.004);
  await page.getByRole("button", { name: "Find Sheltered Route" }).click();
  await expect(page.getByRole("radiogroup", { name: "Route options" })).toBeVisible({ timeout: 60_000 });

  await mode.getByRole("button", { name: "Sun" }).click();
  await expect.poll(async () => shadowedFraction(shadowMask(await sampleMapCanvas(page, SAMPLE_STEP))), {
    timeout: 30_000, message: "switching from rain left stale protection on solar night",
  }).toBeLessThan(0.002);
  await page.getByRole("button", { name: "Find Shadowed Route" }).click();
  await expect(page.getByRole("radiogroup", { name: "Route options" })).toBeVisible({ timeout: 60_000 });
});
