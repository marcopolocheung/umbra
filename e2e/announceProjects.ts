import { hasMapTilerKey } from "../playwright.config";

/**
 * Announce which projects this run will execute, once, before the smoke tests.
 *
 * Registered as `globalSetup` in `playwright.config.ts` only. It used to be a
 * module-scope `console.log` there, which meant it also fired when
 * `playwright.bench.config.ts` imported that file for its shared `use` block —
 * and again inside every spawned worker, where an `argv` guard cannot see the
 * config path. The benchmark therefore printed "running `smoke-live` (real
 * MapTiler tiles)" on a run that is keyless by design.
 */
export default function announceProjects(): void {
  console.log(
    hasMapTilerKey
      ? "[e2e] running `smoke` (fixture basemap), `nav-smoke` (static NYC navigation), " +
          "and `smoke-live` (real MapTiler tiles)."
      : "[e2e] running `smoke` (fixture basemap) and `nav-smoke` (static NYC navigation). " +
          "`smoke-live` needs VITE_MAPTILER_API_KEY and is skipped — it is the only check " +
          "on MapTiler's real building schema.",
  );
}
