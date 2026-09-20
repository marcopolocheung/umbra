import { defineConfig } from "@playwright/test";

// Throwaway screenshot runs for design review (Track U). Not a gate: no assertions
// worth failing, no CI job, and the outputs land in gitignored out/shots/. A design
// PR keeps only its curated few committed under docs/design/shots/u<n>/.
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
