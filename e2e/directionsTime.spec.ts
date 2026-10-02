import { expect, test } from "@playwright/test";
import { SHARE_URL, stubNetwork } from "./helpers/scenario";

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`directions stamp focuses the ${viewport.width < 768 ? "phone" : "desktop"} time editor`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "smoke", "The fixture basemap covers this focus behavior");
    await page.setViewportSize(viewport);
    await stubNetwork(page, { basemap: "fixture" });
    await page.goto(SHARE_URL);
    await page.getByRole("button", { name: /Leaves at .* Change time/ }).filter({ visible: true }).click();
    await expect(page.getByRole("textbox", { name: "Departure time" }).filter({ visible: true })).toBeFocused();
    if (viewport.width < 768) {
      await expect.poll(async () => (await page.getByTestId("bottom-sheet").boundingBox())?.height ?? 0).toBeLessThan(1);
    }
  });
}
