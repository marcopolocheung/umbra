import { expect, test, type Page } from "@playwright/test";
import { SHARE_URL, stubNetwork } from "../helpers/scenario";

/**
 * U4's Doherty check (not a gate, not committed output): the timeline drag is
 * the app's only sub-400ms-critical path, so any pointer-pipeline change must
 * be measured before and after. This hermetic spec drags the slider N times
 * against the served build and reports the median pointer-move →
 * translate-apply latency into the console; run it against two builds
 * (base vs. change) and read both numbers into the PR.
 *
 * It measures the real pipeline: pointerdown → TimelineSlider's
 * requestAnimationFrame-free direct style write. The instrument is a
 * MutationObserver on the ruler's transform plus performance.now() at the
 * pointer event, which is as close to finger→pixel as Playwright can see
 * without CDP input timestamps.
 */

const DRAGS = 30;

async function measureDragLatency(page: Page): Promise<number[]> {
  await stubNetwork(page, { basemap: "fixture" });
  await page.goto(SHARE_URL);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  // Wait for the shadow field's first pass so its repaint cost isn't charged
  // to the drag.
  await page.waitForTimeout(2500);

  // The share link opens the sheet at mid, which covers the timeline; drag
  // the sheet's handle down to the collapsed snap so the timeline rides
  // above the 80px band — the state a one-hand user actually drags in.
  const sheet = page.locator("div.fixed.bottom-0");
  const sbox = await sheet.boundingBox().catch(() => null);
  if (sbox && sbox.height > 120) {
    await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + 20);
    await page.mouse.down();
    await page.mouse.move(sbox.x + sbox.width / 2, 830, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  }

  const slider = page.getByTestId("timeline-slider").filter({ visible: true });
  const box = await slider.boundingBox();
  if (!box) throw new Error("timeline slider has no layout box");
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;

  // Instrument: record the time of every transform write on the ruler.
  await page.evaluate(() => {
    const w = window as unknown as { __dragWrites?: number[] };
    w.__dragWrites = [];
    // Both layouts mount a slider; only the visible one receives the drag.
    const content = Array.from(
      document.querySelectorAll('[data-testid="timeline-slider"]'),
    )
      .find((el) => (el as HTMLElement).offsetParent !== null)
      ?.querySelector("div");
    if (!content) return;
    const obs = new MutationObserver(() => {
      w.__dragWrites!.push(performance.now()); // same clock as the sentAt reads
    });
    obs.observe(content, { attributes: true, attributeFilter: ["style"] });
  });

  const latencies: number[] = [];
  for (let i = 0; i < DRAGS; i++) {
    // One discrete move per drag so the write it triggers is unambiguous.
    const before = await page.evaluate(
      () => (window as unknown as { __dragWrites?: number[] }).__dragWrites!.length,
    );
    const sentAt = await page.evaluate(() => performance.now());
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 20 - i, sy, { steps: 1 });
    const writeAt = await page.evaluate(
      (n) => {
        const w = (window as unknown as { __dragWrites?: number[] }).__dragWrites!;
        // The first write after the recorded count is this drag's.
        const t0 = w[n] ?? null;
        return t0;
      },
      before,
    );
    await page.mouse.up();
    await page.waitForTimeout(60);
    if (writeAt == null) continue;
    // page.evaluate's now() and the observer's timestamps share the same
    // performance.now() origin, so the difference is the pipeline latency.
    const sentMs = sentAt as number;
    latencies.push(writeAt - sentMs);
  }
  return latencies;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

test("timeline drag latency — U4 Doherty measurement", async ({ page }) => {
  const latencies = await measureDragLatency(page);
  // Playwright's own evaluate round-trip is part of the measurement (~1 CDP
  // hop), so this number is an upper bound on the real finger→pixel latency;
  // comparable across builds, which is what the PR needs.
  const med = latencies.length ? median(latencies) : NaN;
  console.log(`DRAG_LATENCY_MS median=${med.toFixed(1)} n=${latencies.length}`);
  // A generous ceiling so a broken pipeline (no writes at all) fails loudly.
  expect(latencies.length).toBeGreaterThan(DRAGS / 2);
});
