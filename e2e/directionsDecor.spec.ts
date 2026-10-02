import { expect, test } from "@playwright/test";
import { SHARE_URL, stubNetwork } from "./helpers/scenario";

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`Directions rail scrolls the real ${viewport.width < 768 ? "sheet" : "sidebar"}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "smoke", "The fixture basemap covers panel scrolling");
    await page.setViewportSize(viewport);
    await stubNetwork(page, { basemap: "fixture" });
    await page.goto(SHARE_URL);
    const scroll = page.locator(viewport.width < 768 ? "#directions-phone-scroll" : "#directions-desktop-scroll");
    const rail = page.getByRole("scrollbar", { name: "Directions sections" }).filter({ visible: true });
    await expect(rail).toBeVisible();
    await expect(scroll).toHaveCSS("scrollbar-width", "none");

    const box = await rail.boundingBox();
    if (!box) throw new Error("Directions rail has no layout box");

    // The rail owns its own gutter: no planning control reaches under it. The
    // docked Find button spans the width below the rail's end, as designed.
    const rightEdges = await page.locator(".directions-planning").filter({ visible: true })
      .locator("button, input, .directions-waypoint").evaluateAll((elements) =>
        elements.filter((element) => !element.closest(".directions-dock") && element.getBoundingClientRect().width > 0)
          .map((element) => element.getBoundingClientRect().right));
    for (const right of rightEdges) expect(right).toBeLessThanOrEqual(box.x + 1);

    // Typing shows only the caret: no focus box around a waypoint field.
    const field = scroll.locator(".directions-waypoint input").first();
    await field.click();
    await expect(field).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Escape");

    // The station tag shows while scrolling and fades soon after.
    const tag = rail.locator(".directions-rail-tag");
    await scroll.evaluate((element) => { element.scrollTop = 40; });
    await expect(tag).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await expect(tag).toHaveCSS("opacity", "0", { timeout: 2000 });
    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * .8);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(rail).not.toHaveAttribute("aria-valuetext", "Start");

    await rail.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
    await page.keyboard.press("End");
    const end = await scroll.evaluate((element) => element.scrollTop);
    expect(end).toBeGreaterThan(0);
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThan(end);

    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    await expect.poll(() => page.evaluate(() => document.body.style.userSelect)).toBe("none");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => document.body.style.userSelect)).not.toBe("none");
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
}

test("rain canvas starts on Rain and cleans up on Sun or reduced motion", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "smoke", "The fixture basemap covers panel rain");
  await page.setViewportSize({ width: 390, height: 844 });
  await stubNetwork(page, { basemap: "fixture" });
  await page.goto(SHARE_URL);
  const objective = page.getByRole("group", { name: "Dodge" }).filter({ visible: true });
  await expect(page.getByTestId("directions-rain-canvas")).toHaveCount(0);
  await objective.getByRole("button", { name: "Rain" }).click();
  await expect(page.getByTestId("directions-rain-canvas").filter({ visible: true })).toBeVisible();
  await objective.getByRole("button", { name: "Sun" }).click();
  await expect(page.getByTestId("directions-rain-canvas")).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await objective.getByRole("button", { name: "Rain" }).click();
  await expect(page.getByTestId("directions-rain-canvas")).toHaveCount(0);
});

test("Directions keeps its controls reachable and its clipped focus visible under reduced motion", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "smoke", "The fixture basemap covers panel presentation");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubNetwork(page, { basemap: "fixture" });
  await page.goto(SHARE_URL);
  const panel = page.locator(".directions-planning").filter({ visible: true });
  for (const control of await panel.locator(".directions-back,.directions-stamp,.directions-tag,.directions-pin-button,.directions-bullet,.directions-board-how").all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  const captionSizes = await panel.locator(".directions-label,.directions-transit-reason").evaluateAll((elements) => elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)));
  expect(Math.min(...captionSizes)).toBeGreaterThanOrEqual(11);
  await page.keyboard.press("Tab");
  for (const control of [panel.locator(".directions-back"), panel.locator(".directions-stamp")]) {
    await control.focus();
    expect(await control.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("inset");
  }
  await expect(panel.locator(".directions-stamp")).toHaveCSS("animation-name", "none");
  await expect(panel.locator(".directions-cta-wrap")).toHaveCSS("animation-name", "none");
  await expect(page.getByTestId("directions-rain-canvas")).toHaveCount(0);
});
