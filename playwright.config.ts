import { defineConfig } from "@playwright/test";
import { loadEnv } from "vite";

// The `smoke-live` project needs real MapTiler vector tiles. `loadEnv` reads the
// same sources the build does — the `.env` files locally, the environment in CI —
// so nobody has to export the key twice.
export const hasMapTilerKey = !!loadEnv("production", process.cwd(), "VITE_")
  .VITE_MAPTILER_API_KEY;

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  // Say which projects will run. A reader who sees one test instead of two should
  // not have to guess why. This is `globalSetup` rather than a module-scope log
  // because `playwright.bench.config.ts` imports this file for its shared `use`
  // block: a module-scope log fires in that config too, and again in every spawned
  // worker, where an `argv` guard cannot see the config path. The keyless benchmark
  // was announcing `smoke-live` — the one thing its own caveat says it never uses.
  globalSetup: "./e2e/announceProjects.ts",
  testDir: "e2e",
  // G2's benchmark has its own config (`playwright.bench.config.ts`). It measures
  // and commits a baseline rather than gating a build, takes minutes, and is
  // meaningful only on one machine — so `npm run e2e`, and therefore CI, skips it.
  testIgnore: ["**/bench/**", "**/shadowV2Debug.spec.ts"],
  // Flake budget: one retry, then fail. A browser test that needs more retries
  // than that is noise, and noisy CI is worse than no CI.
  retries: 1,
  workers: 1,
  // The test's polls sum to 195 s, so the per-test ceiling sits above that: a
  // slow run should fail on the poll's own message, not on a generic test
  // timeout that says nothing about which step gave up. A passing `smoke` run
  // takes ~17 s locally and ~50 s on a 2-core GitHub runner rendering on
  // SwiftShader; `smoke-live` adds ~45 s. A poll that passes early costs nothing.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    browserName: "chromium",
    // Fixed viewport: the app switches layout at Tailwind's `md`, and the pixel
    // assertions count samples off a canvas of exactly this size.
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    timezoneId: "America/New_York",
    // The production build registers `sw.js` (app/main.tsx), and `page.route`
    // does not intercept requests a service worker makes. The MapTiler style is
    // cross-origin, which `sw.js` declines outright — but the `/api/overpass`
    // stub is same-origin and escapes the worker only because one line of
    // `shouldHandle` skips `/api/`. Blocking the worker stops that stub's fate
    // resting on a line in unrelated code.
    serviceWorkers: "block",
    launchOptions: {
      // Headless WebGL2 for MapLibre and the shadow renderer: ANGLE over
      // SwiftShader is the only software path that gives a real GL2 context.
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  projects: [
    // Keyless, so it runs on every PR including forks. Serves a synthetic
    // basemap style with a `maptiler_planet` geojson source.
    { name: "smoke" },
    // Same assertions, real tiles. The only check that the app still parses
    // MapTiler's actual building schema.
    ...(hasMapTilerKey ? [{ name: "smoke-live" }] : []),
  ],
  // Runs against the production build, not the dev server: `import.meta.env.DEV`
  // picks the prod Overpass path, and only the built bundle proves the app the
  // deploy ships actually boots.
  webServer: {
    // --host pins the bind address to the one the poll below dials. Left to
    // default, `vite preview` binds the name `localhost`, which on Node 17+
    // can resolve to ::1 while Playwright waits on 127.0.0.1 and times out.
    command: `npm run build && npm run start -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    // Without this the transit client is compiled out entirely (`configuredBase`
    // returns undefined), and the transit test would pass for the wrong reason.
    // `stubNetwork` serves this origin from `fixtures/transitShards.ts`.
    env: { VITE_TRANSIT_BASE: "https://transit.e2e.test" },
    url: BASE_URL,
    // Never reuse: a preview server already on this port would serve an old
    // dist/ and quietly skip the build, so the test would pass against code
    // that is not the code in the tree.
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
