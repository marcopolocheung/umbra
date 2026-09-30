# Umbra redesign 2.0 — R0 design specimens

`preview.html` is the editable, offline source for the 390×844 day and night phone renders. The two `*-phone.png` files show all four R0 surfaces; each surface also has a cropped PNG for closer review. Day shows a 14:00 shade estimate; night shows 22:00 with the sun below the horizon, so the shade percentage and split bar disappear. Numbers are illustrative design content, explicitly labelled in the render. The app UI is unchanged in R0.

The preview uses local Latin-subset WOFF2 files from the selected openly licensed fonts. Their license notices are included in `fonts/`. The original [reference document](../../redesign-2.0/reference.html) uses the same local files and remains a vocabulary archive; the selected roles and outdoor contrast limits live in [`decision.md`](../../decision.md#umbra-redesign-20--r0-decision-2026-09-29) and [`language.md`](../../language.md).

To regenerate the images, open `preview.html?theme=day` or `?theme=night` in a 390×844 browser viewport at device scale 2, wait for `document.fonts.ready`, capture the page, then capture each `[data-vignette]` element. The exact Playwright capture recipe used for R0 is:

```js
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
for (const theme of ['day', 'night']) {
  await page.goto(`file://${process.cwd()}/docs/design/candidates/redesign-2.0/preview.html?theme=${theme}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/design/candidates/redesign-2.0/${theme}-phone.png` });
  for (const name of ['search', 'route', 'timeline', 'arrival']) {
    await page.locator(`[data-vignette="${name}"]`).screenshot({ path: `docs/design/candidates/redesign-2.0/${theme}-${name}.png` });
  }
}
await browser.close();
```
