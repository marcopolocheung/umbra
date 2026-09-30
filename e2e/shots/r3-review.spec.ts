import path from "node:path";
import { expect, test } from "@playwright/test";
import { SHARE_URL, stubNetwork } from "../helpers/scenario";

// Run with R3_STAGE=before against the R2 preview, then R3_STAGE=after against
// the R3 preview. Both use this exact fixture, share link, viewport and timing.
const stage = process.env.R3_STAGE;
test.skip(stage !== "before" && stage !== "after", "R3 review capture is opt-in");
const out = path.join(process.cwd(), "docs/design/shots/r3");

const specimenCss = `
  body { margin: 0; background: var(--color-ground); color: var(--color-ink); }
  #specimen { box-sizing: border-box; width: 390px; height: 844px; padding: 24px 20px; overflow: hidden; font-family: var(--font-body); }
  .note { font-family: var(--font-mono); font-size: 11px; letter-spacing: .04em; color: var(--color-ink-muted); margin: 0 0 22px; }
  .row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 18px 0; }
  .sample-plate { display: block; padding: 20px; margin: 18px 0; }
  .sample-title { font-family: var(--font-display); font-size: 29px; font-weight: 800; line-height: 1.1; margin: 6px 0 14px; }
  .sample-number { font-size: 34px; font-weight: 800; }
  .sample-sub { font-size: 13px; margin: 8px 0 0; }
  .sample-grain { padding: 18px; border: 1px solid var(--color-ink-muted); margin-top: 20px; }
  .focus-plate { padding: 20px; margin: 24px 0; }
  .reveal-card { width: 310px; height: 180px; padding: 20px; margin: 55px 0 0 8px; background: var(--color-shade); color: var(--color-on-shade); box-shadow: var(--shadow-hard-2); }
  .reveal-card strong { display: block; font-family: var(--font-label); font-size: 30px; text-transform: uppercase; }
  .reveal-card span { display: block; margin-top: 18px; font-size: 18px; }
`;

const ground = '<span class="umbra-plate__ground" aria-hidden="true"></span>';
const line = '<span class="umbra-line-bullet umbra-line-bullet--blue" tabindex="0"><span class="umbra-line-bullet__id">A</span><span class="umbra-line-bullet__label">Uptown</span></span>';
const stamp = '<span class="umbra-stamp-badge" tabindex="0"><span class="umbra-stamp-badge__ink">Arrived</span></span>';

function specimen(kind: "primitives" | "focus" | "reveal"): string {
  if (kind === "primitives") return `
    <main id="specimen"><p class="note">R3 primitives · specimen copy</p>
      <span class="umbra-kicker">Keep cool on</span><h1 class="sample-title">Bleecker Street</h1>
      <section class="umbra-plate umbra-plate--panel sample-plate" tabindex="0">
        <span class="umbra-kicker umbra-plate umbra-plate--ink umbra-plate--tilt">Shade walk${ground}</span>
        <div class="sample-number">18 min</div><p class="sample-sub">Panel plate · clipped ground · square host</p>
        <div class="row"><span class="umbra-tag umbra-tag--neutral" tabindex="0">Neutral</span><span class="umbra-tag umbra-tag--sun">Sun</span><span class="umbra-tag umbra-tag--shade">Shade</span><span class="umbra-tag umbra-tag--canopy">Canopy</span><span class="umbra-tag umbra-tag--rain">Rain</span><span class="umbra-tag umbra-tag--danger">Danger</span></div>${ground}
      </section>
      <section class="umbra-plate umbra-plate--shade umbra-plate--tilt sample-plate" tabindex="0"><span class="umbra-kicker">Bare kicker on shade</span><p class="sample-sub">Tilted paint; square content box</p>${ground}</section>
      <div class="row">${line}<span class="umbra-line-bullet umbra-line-bullet--green"><span class="umbra-line-bullet__id">4</span><span class="umbra-line-bullet__label">Express</span></span><span class="umbra-line-bullet umbra-line-bullet--yellow"><span class="umbra-line-bullet__id">Q</span></span></div>
      <div class="row">${stamp}<span class="umbra-stamp-badge umbra-stamp-badge--sun"><span class="umbra-stamp-badge__ink">Sun</span></span><span class="umbra-stamp-badge umbra-stamp-badge--shade"><span class="umbra-stamp-badge__ink">Shaded</span></span></div>
      <div class="umbra-grain sample-grain" tabindex="0">GrainSurface · paper texture</div>
    </main>`;
  if (kind === "focus") return `
    <main id="specimen"><p class="note">R3 keyboard focus · page ink</p>
      <div class="row"><span class="umbra-tag umbra-tag--neutral" tabindex="0" id="focus-tag">Tag</span><span class="umbra-line-bullet umbra-line-bullet--yellow" tabindex="0" id="focus-q"><span class="umbra-line-bullet__id">Q</span></span></div>
      <div class="row"><span id="focus-line">${line}</span>${stamp}</div>
      <section id="focus-panel" class="umbra-plate umbra-plate--panel focus-plate" tabindex="0">Focused panel plate${ground}</section>
      <section id="focus-shade" class="umbra-plate umbra-plate--shade umbra-plate--tilt focus-plate" tabindex="0">Focused tilted shade plate${ground}</section>
      <div class="umbra-grain sample-grain" tabindex="0">Focused grain surface</div>
    </main>`;
  return `<main id="specimen"><p class="note">R3 ink mask · paused at 150 / 300 ms</p>
    <div id="reveal" class="umbra-ink-reveal reveal-card"><strong>Shade walk</strong><span>Printed through a rough ink edge.</span></div>
    <p class="note" style="margin-top: 45px">Opaque through 82% of mask width; flecks at the leading edge.</p>
  </main>`;
}

for (const theme of ["day", "night"] as const) {
  test(`R3 review ${theme}`, async ({ page }) => {
    await stubNetwork(page, { basemap: "fixture" });
    await page.addInitScript((value) => localStorage.setItem("umbra:uiTheme", value), theme);
    await page.goto(SHARE_URL);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(out, stage!, theme, "app-directions.png") });
    if (stage === "before") return;

    await page.evaluate(() => { document.body.replaceChildren(); });
    await page.addStyleTag({ content: specimenCss });
    await page.evaluate(async () => { await document.fonts.ready; });
    for (const kind of ["primitives", "focus", "reveal"] as const) {
      await page.evaluate((html) => { document.body.innerHTML = html; }, specimen(kind));
      if (kind === "focus") {
        // A review sheet shows several focus states simultaneously. Force the
        // real :focus-visible pseudo-class instead of cloning its CSS rules.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        for (const selector of ["#focus-tag", "#focus-q", "#focus-line .umbra-line-bullet", ".umbra-stamp-badge", "#focus-panel", "#focus-shade", ".umbra-grain"]) {
          const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
          await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus-visible"] });
        }
      }
      if (kind === "reveal") {
        await page.evaluate(() => {
          const animation = document.getElementById("reveal")?.getAnimations()[0];
          if (!animation) throw new Error("ink reveal animation missing");
          animation.pause();
          animation.currentTime = 150;
        });
        await expect.poll(() => page.locator("#reveal").evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");
        const size = await page.locator("#reveal").evaluate((el) => getComputedStyle(el).maskSize);
        expect(parseFloat(size)).toBeGreaterThan(60);
        expect(parseFloat(size)).toBeLessThan(70);
      }
      await page.screenshot({ path: path.join(out, `${kind}-${theme}.png`) });
    }

    await page.locator("#reveal").evaluate((el) => el.getAnimations()[0].finish());
    await expect.poll(() => page.locator("#reveal").evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
    await expect(page.locator("#reveal")).toHaveCSS("clip-path", "none");
    await expect(page.locator("#reveal")).toHaveCSS("opacity", "1");
    await expect(page.locator("#reveal")).not.toHaveCSS("box-shadow", "none");
    const completed = await page.screenshot();
    const [shadowPixel, groundPixel] = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return [[680, 300], [700, 300]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
    }, `data:image/png;base64,${completed.toString("base64")}`);
    expect(shadowPixel).not.toEqual(groundPixel);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate((html) => { document.body.innerHTML = html; }, specimen("reveal"));
    await expect(page.locator("#reveal")).toHaveCSS("animation-name", "none");
    await expect(page.locator("#reveal")).toHaveCSS("mask-image", "none");
    await expect(page.locator("#reveal")).toHaveCSS("opacity", "1");
  });
}
