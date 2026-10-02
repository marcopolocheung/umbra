import { expect, test, type Page } from "@playwright/test";
import { SHARE_URL, stubNetwork } from "./helpers/scenario";

async function grab(page: Page, grip: ReturnType<Page["getByTestId"]>) {
  await grip.scrollIntoViewIfNeeded();
  const box = await grip.boundingBox();
  if (!box) throw new Error("Route preview grip has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

test("route preview moves freely and pops into and out of the trip panel", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "smoke", "Layout behavior is covered by the fixture basemap");
  await stubNetwork(page, { basemap: "fixture" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(SHARE_URL);
  await page.getByRole("button", { name: "Find the shade" }).filter({ visible: true }).click();

  const docked = page.getByTestId("route-preview-docked");
  const floating = page.getByTestId("route-preview-floating");
  const dockGrip = page.getByTestId("route-preview-dock-grip");
  const floatGrip = page.getByTestId("route-preview-float-grip");
  await expect(docked.getByRole("button", { name: "START NAVIGATING" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(floating).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move to trip panel" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show on map" })).toHaveCount(0);

  const optionButtons = docked
    .getByRole("radiogroup", { name: "Route options" })
    .locator("button[aria-pressed]");
  const selectedIndex = (await optionButtons.count()) - 1;
  expect(selectedIndex).toBeGreaterThanOrEqual(0);
  await optionButtons.nth(selectedIndex).click();

  // Pull the docked strip across the sidebar edge. Placement changes before release.
  await grab(page, dockGrip);
  await page.mouse.move(760, 330, { steps: 12 });
  await expect(floating).toBeVisible();
  await expect(docked).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Open panel" })).toBeVisible();
  await expect(
    floating
      .getByRole("radiogroup", { name: "Route options" })
      .locator("button[aria-pressed]")
      .nth(selectedIndex),
  ).toHaveAttribute("aria-pressed", "true");

  // The floating window follows its grip across the map, not just between two fixed positions.
  const beforeMove = await floating.boundingBox();
  await grab(page, floatGrip);
  await page.mouse.move(920, 460, { steps: 10 });
  await page.mouse.up();
  const afterMove = await floating.boundingBox();
  if (!beforeMove || !afterMove) throw new Error("Floating preview has no layout box");
  expect(afterMove.x).toBeGreaterThan(beforeMove.x + 20);
  expect(afterMove.y).toBeGreaterThan(beforeMove.y + 20);

  // The exposed sidebar tab is a drop target even while the panel is closed.
  await grab(page, floatGrip);
  await page.mouse.move(20, 320, { steps: 14 });
  await expect(docked).toBeVisible();
  await expect(floating).toHaveCount(0);
  await page.mouse.up();
  await expect(docked).toBeVisible();

  // Escape restores the dock after a drag has crossed onto the map.
  await grab(page, dockGrip);
  await page.mouse.move(760, 330, { steps: 10 });
  await expect(floating).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(docked).toBeVisible();

  // The grip also has a one-click and keyboard path for users who cannot drag.
  await dockGrip.click();
  await expect(floating).toBeVisible();
  await floatGrip.focus();
  await page.keyboard.press("Enter");
  await expect(docked).toBeVisible();

  // The whole open sidebar, not only its closed tab, also accepts the preview.
  await page.setViewportSize({ width: 1280, height: 900 });
  await dockGrip.click();
  await page.getByRole("button", { name: "Open panel" }).click();
  await expect(floating).toBeVisible();
  await grab(page, floatGrip);
  await page.mouse.move(200, 320, { steps: 10 });
  await expect(docked).toBeVisible();
  await page.mouse.up();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(docked).toBeHidden();
  await expect(floating).toBeHidden();
  await expect(
    page.getByRole("radiogroup", { name: "Route options" }).filter({ visible: true }),
  ).toHaveCount(1);

  await page.setViewportSize({ width: 1280, height: 900 });
  await docked.getByRole("button", { name: "START NAVIGATING" }).click();
  await expect(docked).toHaveCount(0);
  await page.getByRole("button", { name: "Back to route options" }).click();
  await dockGrip.click();
  await floating.getByRole("button", { name: "START NAVIGATING" }).click();
  await expect(floating).toHaveCount(0);
});
