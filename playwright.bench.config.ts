import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

/**
 * G2's route benchmark. Separate from `playwright.config.ts` on purpose.
 *
 * The benchmark **measures and commits a baseline; it does not gate a build**.
 * Failing CI on a regression is G3. Keeping it in its own config is what makes
 * that true mechanically rather than by convention: `npm run e2e` cannot pick it
 * up, and CI — which runs `npm run e2e` — never spends four minutes on it.
 *
 * The keyless project runs exactly the scenario set the Phase-0 note
 * committed; the `bench-nav` project adds the `nav-static` scenarios the A4
 * session uses to time the real static street/building fetch. Real MapTiler
 * tile fetches still never enter a performance number: network variance inside
 * the baseline is the thing G2 exists to keep out.
 *
 * The canonical environment is a developer machine, not a GitHub runner: a 2-core
 * runner on SwiftShader is roughly 3x slower, so a before/after comparison has to
 * happen on one machine and the baseline names which.
 */
export default defineConfig({
  ...baseConfig,
  testDir: "e2e/bench",
  // Canopy has a separate live-network config. Without an explicit match, adding
  // those specs made the keyless route command wait on source.coop before G2 ran.
  testMatch: ["**/routeCalc.bench.spec.ts", "**/detourSweep.bench.spec.ts"],
  testIgnore: undefined,
  // The smoke config's project announcement must not run here: this config runs
  // neither `smoke` nor `smoke-live`, and saying otherwise in the output of a
  // benchmark whose headline caveat is "keyless" is worse than saying nothing.
  globalSetup: undefined,
  // No retries. A benchmark that silently re-ran a bad sample would report the
  // luckier of two runs, which is the one thing a baseline must not do.
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  // Cold scenarios pay a full page load per repeat, and the map has to paint
  // under SwiftShader before each one counts.
  timeout: 600_000,
  // Two projects share one spec against two builds — the keyless build and the
  // static-navigation build — because `VITE_*` values are baked into the
  // bundle and the Phase-0 keyless columns must stay the measurements of a
  // build that performs **no** navigation-data request at all. A single build
  // whose env cannot differ per scenario would force every keyless run through
  // an aborted pointer fetch first, pushing its `navSnapshot` column off zero
  // by however long the renderer stays busy after the previous calculation —
  // possible on the per-leg 5-point loop, impossible to keep comparable.
  // `bench` runs the committed scenario set against the keyless build;
  // `bench-nav` runs the `nav-static` additions against the configured build.
  projects: [
    { name: "bench", grepInvert: /nav-static/, use: { baseURL: "http://127.0.0.1:4191" } },
    { name: "bench-nav", grep: /nav-static/, use: { baseURL: "http://127.0.0.1:4192" } },
  ],
  // Two preview servers, one per project build, on ports (4191/4192) chosen to
  // stay clear of the smoke suite's 4173 — another session's preview there
  // used to collide with, or be killed alongside, these. Never reuse either: a
  // preview server already on one of these ports would serve an old build and
  // quietly skip the rebuild. The builds use sibling top-level out-dirs, not nested
  // `dist/…` both under one `vite build --emptyOutDir` — the second build
  // empties its own out-dir and would otherwise delete the first one's
  // already-served bundle. Both env bases must match `e2e/helpers/scenario.ts`.
  webServer: [
    {
      command: `npm run build -- --outDir bench-dist/keyless && npm run start -- --outDir bench-dist/keyless --host 127.0.0.1 --port 4191 --strictPort`,
      env: { VITE_TRANSIT_BASE: "https://transit.e2e.test" },
      url: "http://127.0.0.1:4191",
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: `npm run build -- --outDir bench-dist/nav && npm run start -- --outDir bench-dist/nav --host 127.0.0.1 --port 4192 --strictPort`,
      env: {
        VITE_TRANSIT_BASE: "https://transit.e2e.test",
        VITE_NAVIGATION_BASE: "https://navigation.e2e.test",
      },
      url: "http://127.0.0.1:4192",
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
