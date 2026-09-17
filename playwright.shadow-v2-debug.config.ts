import { defineConfig } from "@playwright/test";

const PORT = 4174;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Debug-only browser topology: the Worker origin is mocked by the spec. */
export default defineConfig({
  testDir: "e2e",
  testMatch: "shadowV2Debug.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: BASE_URL, browserName: "chromium", viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `npm run build && npm run start -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { VITE_SHADOW_V2_DEBUG: "true", VITE_SHADOW_API_BASE: "https://shadow.e2e.test", VITE_TRANSIT_BASE: "https://transit.e2e.test" },
    url: BASE_URL, reuseExistingServer: false, timeout: 120_000,
  },
});
