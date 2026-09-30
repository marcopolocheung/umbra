import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadEnv } from "vite";
import { sampleMapCanvas, shadowedFraction, shadowMask } from "../helpers/map";
import { SHARE_URL, START_TIME, stubNetwork } from "../helpers/scenario";

// Run with R4_STAGE=before against the R3 preview, then R4_STAGE=after against the
// R4 preview. Auto theme, so the basemap and the UI both follow the sun: 09:00 is
// day, 22:00 is after the June sunset. Real MapTiler tiles when a key is present.
const stage = process.env.R4_STAGE;
test.skip(stage !== "before" && stage !== "after", "R4 review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r4", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`R4 review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.goto(SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(6000); // tiles, then the first shadow pass

    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `app-${theme}.png`) });
    // The map alone, at the canvas's own resolution (readable by invariant #3).
    const png = await page.evaluate(() =>
      document.querySelector<HTMLCanvasElement>("canvas.maplibregl-canvas")!.toDataURL("image/png")
    );
    fs.writeFileSync(path.join(out, `map-${theme}.png`), Buffer.from(png.split(",")[1], "base64"));
    const shaded = shadowedFraction(shadowMask(await sampleMapCanvas(page, 4)));
    if (stage === "after") {
      if (theme === "night") expect(shaded).toBeLessThan(0.002);
      else expect(shaded).toBeGreaterThan(0.02);
    }
    console.log(`R4 ${stage} ${theme} ${live ? "live" : "fixture"}: shadow-predicate share ${(shaded * 100).toFixed(1)}%`);
  });
}

test("R4 review night rain", async ({ page }) => {
  test.skip(stage !== "after", "The rain comparison belongs to the R4a after set");
  await stubNetwork(page, { basemap: live ? "live" : "fixture" });
  await page.goto(SHARE_URL.replace(`time=${START_TIME}`, "time=22:00"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  const rain = page.getByTestId("rain-mode-selector").filter({ visible: true }).getByRole("button", { name: "Rain" });
  await rain.click();
  await expect(rain).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => shadowedFraction(shadowMask(await sampleMapCanvas(page, 4))), {
    timeout: 90_000,
  }).toBeGreaterThan(0.002);
  await page.evaluate(async () => { await document.fonts.ready; });
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, "app-night-rain.png") });
  const png = await page.evaluate(() =>
    document.querySelector<HTMLCanvasElement>("canvas.maplibregl-canvas")!.toDataURL("image/png")
  );
  fs.writeFileSync(path.join(out, "map-night-rain.png"), Buffer.from(png.split(",")[1], "base64"));
});
