/**
 * A shared cooperative scheduler for long synchronous loops (Stage B of the
 * routing latency repair).
 *
 * The pattern it replaces: yield with `setTimeout(…, 0)` after a fixed count
 * of edges. At 80,000 sampled segments the old loop yielded 800 times, and a
 * browser timer slot is not free — Chromium measured **3.53 s** of pure
 * timer-pause overhead for those yields, before any of the actual sampling
 * work. A fixed edge count is the wrong unit twice over: it pauses far too
 * often on cheap edges and not often enough on expensive ones.
 *
 * The scheduler yields after roughly **8 ms of actual work**, never after a
 * fixed count, and uses the cheapest continuation the platform offers:
 * `scheduler.yield()` where it exists (Chrome 129+), a `MessageChannel`
 * continuation otherwise. Both let input and paint interleave far sooner than
 * a macrotask timer.
 *
 * It is one module on purpose: every long loop in the pipeline should share
 * these definitions so "how often we pause" is a decision made once, not
 * per loop.
 */

/** Roughly how much work to do before yielding, in wall-clock ms. */
export const YIELD_WORK_SLICE_MS = 8;

/**
 * Yields control to the browser, continuing on the cheapest available
 * mechanism. `scheduler.yield()` is a continuation that the scheduler can
 * place promptly; `MessageChannel` posts a macrotask without a timer slot —
 * unlike `setTimeout(0)`, which every browser clamps and queues behind
 * timers, painting and other timers.
 */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/**
 * Whether enough time has passed since `startedAt` that the loop should pause.
 * Called cheaply (one `performance.now()` read) after each unit of work.
 */
export function shouldYield(startedAt: number): boolean {
  return performance.now() - startedAt >= YIELD_WORK_SLICE_MS;
}

/** Visible-progress throttle: at most this many updates per second. */
export const PROGRESS_UPDATES_PER_SEC = 10;

const PROGRESS_MIN_INTERVAL_MS = 1000 / PROGRESS_UPDATES_PER_SEC;

/**
 * Whether a visible progress update is due, given the last one's timestamp.
 * Phase changes and completion are always delivered by the caller — this only
 * throttles the in-phase counter ticks, so a slow phase still reports at 10 Hz
 * and a fast one does not spam a repaint per edge.
 */
export function progressUpdateDue(lastUpdateAt: number): boolean {
  return performance.now() - lastUpdateAt >= PROGRESS_MIN_INTERVAL_MS;
}
