import { defineConfig } from "@playwright/test";
import baseConfig from "../playwright.config";

/**
 * A8a's canopy transport measurement. A third config, for two reasons that the
 * other two cannot accommodate.
 *
 * **It needs the live network.** `npm run e2e` stubs every request it makes and
 * `npm run bench:route` is keyless on purpose, because network variance inside a
 * performance baseline is exactly what a baseline must not contain. Here the
 * network *is* the measurement: the question A8a answers is what a browser pays
 * to read a route-sized area of canopy from `source.coop`, and no stub can answer that.
 * So this never runs in CI, and its numbers name the machine and date they were
 * taken on.
 *
 * **It needs the dev server, not the preview build.** The harness page imports
 * `app/lib/canopyRaster/` directly and nothing else; `vite preview` only serves
 * `dist/`, which contains the app and not this page. Keeping the harness out of
 * the app bundle is the point — A8a has no routing effect and no UI, and adding
 * an entry point to the shipped build to measure it would be the tail wagging
 * the dog.
 */
const PORT = 5178;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  ...baseConfig,
  testDir: "bench",
  testMatch: "**/canopy*.bench.spec.ts",
  testIgnore: undefined,
  globalSetup: undefined,
  // No retries: a retried network measurement reports the luckier of two runs.
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 300_000,
  projects: [{ name: "canopy" }],
  use: {
    ...baseConfig.use,
    baseURL: BASE_URL,
    launchOptions: {
      // `performance.memory` is quantised into coarse buckets and cached without
      // this flag, which is enough to hide a multi-megabyte raster. It makes each
      // read expensive, so the benchmark reads it exactly twice per AOI. The
      // baseline collection is a CDP `HeapProfiler.collectGarbage` instead, which
      // needs no flag at all.
      args: ["--enable-precise-memory-info"],
    },
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    cwd: "..",
  },
});
