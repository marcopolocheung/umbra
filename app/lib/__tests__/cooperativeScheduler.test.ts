import { describe, expect, it, vi } from "vitest";
import {
  PROGRESS_UPDATES_PER_SEC,
  YIELD_WORK_SLICE_MS,
  progressUpdateDue,
  shouldYield,
  yieldToEventLoop,
} from "../cooperativeScheduler";

describe("cooperativeScheduler", () => {
  it("yields on the MessageChannel continuation when scheduler.yield is absent", async () => {
    // jsdom has no scheduler.yield; the fallback must still resolve promptly
    // (this is exactly the browser path that replaces setTimeout(0)).
    const t = performance.now();
    await yieldToEventLoop();
    // A timer-slot yield would sit behind the 4 ms clamp; a MessageChannel
    // macrotask resolves far sooner. Generous bound so CI variance passes.
    expect(performance.now() - t).toBeLessThan(YIELD_WORK_SLICE_MS * 4);
  });

  it("prefers scheduler.yield when the platform provides it", async () => {
    const yieldSpy = vi.fn(() => Promise.resolve());
    const original = (globalThis as { scheduler?: unknown }).scheduler;
    (globalThis as { scheduler?: unknown }).scheduler = { yield: yieldSpy };
    try {
      await yieldToEventLoop();
    } finally {
      if (original === undefined) delete (globalThis as { scheduler?: unknown }).scheduler;
      else (globalThis as { scheduler?: unknown }).scheduler = original;
    }
    expect(yieldSpy).toHaveBeenCalledTimes(1);
  });

  it("asks for a yield only once the work slice has elapsed", () => {
    const started = performance.now();
    expect(shouldYield(started)).toBe(false);
    // Inside the slice: not yet, however many edges passed — the unit is time.
    expect(shouldYield(started)).toBe(false);
    expect(shouldYield(started - YIELD_WORK_SLICE_MS - 1)).toBe(true);
  });

  it("throttles progress to at most the published rate", () => {
    expect(PROGRESS_UPDATES_PER_SEC).toBe(10);
    const now = performance.now();
    // Immediately after an update: suppressed.
    expect(progressUpdateDue(now)).toBe(false);
    // After the full interval: due.
    expect(progressUpdateDue(now - 1000 / PROGRESS_UPDATES_PER_SEC)).toBe(true);
  });
});
