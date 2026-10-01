import { expect, test } from "@playwright/test";
import { SHARE_URL, stubNetwork } from "./helpers/scenario";

test("desktop route preview docks and remains available when the sidebar closes", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "smoke", "Layout behavior is covered by the fixture basemap");
  await stubNetwork(page, { basemap: "fixture" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(SHARE_URL);
  await page.getByRole("button", { name: "Find Shadowed Route" }).filter({ visible: true }).click();

  const docked = page.getByTestId("route-preview-docked");
  const floating = page.getByTestId("route-preview-floating");
  await expect(docked.getByRole("button", { name: "START NAVIGATING" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(floating).toHaveCount(0);

  const options = docked.getByRole("radiogroup", { name: "Route options" });
  const optionButtons = options.locator("button[aria-pressed]");
  const optionCount = await optionButtons.count();
  expect(optionCount).toBeGreaterThan(0);
  const selectedIndex = optionCount - 1;
  await optionButtons.nth(selectedIndex).click();
  await expect(optionButtons.nth(selectedIndex)).toHaveAttribute("aria-pressed", "true");

  await docked.getByRole("button", { name: "Show on map" }).click();
  await expect(docked).toHaveCount(0);
  await expect(floating).toBeVisible();
  await expect(
    floating
      .getByRole("radiogroup", { name: "Route options" })
      .locator("button[aria-pressed]")
      .nth(selectedIndex),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Open panel" }).click();
  await expect(docked).toBeVisible();
  await expect(floating).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(floating).toBeVisible();
  await expect(docked).toHaveCount(0);
  await floating.getByRole("button", { name: "Move to trip panel" }).click();
  await expect(docked).toBeVisible();

  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(floating).toBeVisible();
  await page.getByRole("button", { name: "Open panel" }).click();
  await expect(docked).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(docked).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(docked).toBeVisible();

  await docked.getByRole("button", { name: "Show on map" }).click();
  await expect(floating).toBeVisible();
  await expect(docked).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(floating).toBeHidden();
  await expect(docked).toBeHidden();
  await expect(
    page.getByRole("radiogroup", { name: "Route options" }).filter({ visible: true }),
  ).toHaveCount(1);

  await page.setViewportSize({ width: 1280, height: 900 });
  await floating.getByRole("button", { name: "START NAVIGATING" }).click();
  await expect(floating).toHaveCount(0);
  await page.getByRole("button", { name: "Back to route options" }).click();
  await expect(floating).toBeVisible();
  await floating.getByRole("button", { name: "Move to trip panel" }).click();
  await docked.getByRole("button", { name: "START NAVIGATING" }).click();
  await expect(docked).toHaveCount(0);
});
