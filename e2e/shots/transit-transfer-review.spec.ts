import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { START_TIME, TRANSIT_SHARE_URL, stubNetwork } from "../helpers/scenario";

const stage = process.env.TRANSFER_STAGE;
test.skip(stage !== "before" && stage !== "after", "transfer card capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/transit-transfer", stage ?? "");

async function raiseSheet(page: Page) {
  const box = await page.getByTestId("bottom-sheet").boundingBox();
  if (!box) throw new Error("bottom sheet has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, 80, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}

for (const [theme, time] of [["day", START_TIME], ["night", "22:00"]] as const) {
  test(`transfer card ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: "fixture", transit: "transfer" });
    await page.goto(TRANSIT_SHARE_URL.replace(`time=${START_TIME}`, `time=${time}`));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: "Transit", exact: true }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "Find the shade" }).click();
    await expect.poll(() => page.evaluate(() =>
      document.querySelector('[role="radiogroup"][aria-label="Route options"]')?.textContent ?? "",
    ), { timeout: 60_000 }).toContain("Via Subway");
    await page.evaluate(async () => { await document.fonts.ready; });
    await raiseSheet(page);
    if (stage === "after") await expect(page.getByRole("button", { name: "START NAVIGATING" }).filter({ visible: true }).first()).toBeInViewport({ ratio: 1 });
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `card-${theme}.png`) });
    const hideSheet = await page.addStyleTag({ content: '[data-testid="bottom-sheet"] { display: none !important; }' });
    await page.screenshot({ path: path.join(out, `map-${theme}.png`) });
    await hideSheet.evaluate((element) => element.parentNode?.removeChild(element));
    await page.getByRole("button", { name: "START NAVIGATING" }).filter({ visible: true }).first().click();
    await expect(page.getByRole("list", { name: "Route steps" }).first()).toBeVisible();
    await raiseSheet(page);
    if (stage === "after") {
      await expect(page.getByRole("button", { name: "Back to route options" }).filter({ visible: true }).first()).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("button", { name: "End navigation" }).filter({ visible: true }).first()).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({ path: path.join(out, `navigating-${theme}.png`) });
  });
}
