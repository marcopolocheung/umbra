import { defineConfig } from "@playwright/test";

// Throwaway screenshot runs for design review (Track R). The harness verifies
// each forced palette, then writes PNGs to gitignored out/shots/{day,night}/.
// Curated review shots live under docs/design/shots/r<n>/.
//
// Runs against the preview build on port 4173 (the same command playwright.config.ts
// uses), or reuses whatever server is already on that port — that is the fast
// feedback loop: `npm run shots` during a design session reshots states in seconds.
// The stale-server caveat: if 4173 serves an old build, reshoot with the server
// stopped or `npm run start` after a fresh build.
const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e/shots",
  testMatch: ["design-shots.spec.ts", "r3-review.spec.ts", "r4-review.spec.ts", "r4b-review.spec.ts"],
  retries: 0,
  workers: 1,
  timeout: 180_000,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
    browserName: "chromium",
    // Phone-first. The wave reviews at 390x844 before anything else (owner decision D8).
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    timezoneId: "America/Chicago",
    serviceWorkers: "block",
    launchOptions: {
      // Headless WebGL2 for MapLibre and the shadow renderer: ANGLE over
      // SwiftShader is the only software path that gives a real GL2 context
      // (same as the main e2e config).
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: `npm run build && npm run start -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
