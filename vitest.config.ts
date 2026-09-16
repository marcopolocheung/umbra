import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "app/{lib,services,hooks,components}/**/__tests__/**/*.test.{ts,tsx}",
      // Pure Worker allow-list/gating logic (no workerd APIs at import time).
      "cloudflare/shadow-data-worker/src/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "app/lib/**/*.{ts,tsx}",
        "app/services/**/*.{ts,tsx}",
        "app/hooks/**/*.{ts,tsx}",
        "app/components/**/*.{ts,tsx}",
      ],
      exclude: [
        "app/**/__tests__/**",
        "app/**/*.d.ts",
      ],
    },
  },
});
