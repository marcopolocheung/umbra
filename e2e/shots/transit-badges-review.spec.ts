import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadEnv } from "vite";
import { START_TIME, TRANSIT_SHARE_URL, stubNetwork } from "../helpers/scenario";

// #149 review: the fixture subway ride on the map with the sheet hidden, day 09:00 and
// night 22:00. BADGES_STAGE=before against main's preview, =after against this branch's;
// both builds need VITE_TRANSIT_BASE=https://transit.e2e.test.
const stage = process.env.BADGES_STAGE;
test.skip(stage !== "before" && stage !== "after", "transit badge capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/transit-badges", stage ?? "");
const live = Boolean(loadEnv("production", process.cwd(), "VITE_").VITE_MAPTILER_API_KEY);

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`transit badges ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: live ? "live" : "fixture" });
    await page.goto(TRANSIT_SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "Transit", exact: true }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "Find the shade" }).filter({ visible: true }).first().click();
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as { __umbraMetrics?: { latest?: unknown } }).__umbraMetrics?.latest)), {
        timeout: 60_000,
      })
      .toBe(true);
    await page.waitForTimeout(2500);
    if (stage === "after") {
      const view = page.viewportSize()!;
      for (const part of await page.locator("[data-part='stop-flag'] [data-part='kicker'], [data-part='stop-flag'] [data-part='shield']").all()) {
        const box = await part.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(view.width);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(view.height);
      }
      const connections = await page.locator("[data-part='stop-flag']").evaluateAll((hosts) => hosts.map((host) => {
        const anchor = host.getBoundingClientRect();
        const shield = host.querySelector("[data-part='shield']")!.getBoundingClientRect();
        const path = host.querySelector("[data-part='leader']")!.getAttribute("d")!;
        const match = path.match(/L(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)!;
        const x = anchor.left + Number(match[1]);
        const y = anchor.top + Number(match[2]);
        return {
          gap: Math.hypot(Math.max(shield.left - x, 0, x - shield.right), Math.max(shield.top - y, 0, y - shield.bottom)),
          doorClear: shield.left > anchor.left + 5 || shield.right < anchor.left - 5 ||
            shield.top > anchor.top + 5 || shield.bottom < anchor.top - 5,
        };
      }));
      for (const connection of connections) {
        expect(connection.gap).toBeLessThanOrEqual(1);
        expect(connection.doorClear).toBe(true);
      }
    }
    fs.mkdirSync(out, { recursive: true });
    await page.addStyleTag({ content: "[data-testid='bottom-sheet'] { visibility: hidden !important; }" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `map-${theme}.png`) });

    // Mid-pull: the coin grabbed and pulled 40 px off its line, held on the rubber band.
    const coin = page.locator(".maplibregl-marker[aria-label='Line E'] [data-part='grip']");
    if (stage === "after" && (await coin.count()) === 1) {
      const box = await coin.boundingBox();
      if (box) {
        const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 28, y - 28, { steps: 6 });
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(out, `pull-${theme}.png`) });
        await page.mouse.up();
      }
    }
  });
}
