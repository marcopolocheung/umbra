import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `app/lib/css-tokens.ts` parses the token registry (app/globals.css) from
    // its `?raw` source; without the CSS pipeline those imports are empty stubs
    // and every token() call throws.
    css: true,
    include: [
      "app/{lib,services,hooks,components}/**/__tests__/**/*.test.{ts,tsx}",
      // Pure Worker allow-list/gating logic (no workerd APIs at import time).
      "cloudflare/shadow-data-worker/src/**/*.test.ts",
      "cloudflare/navigation-data-worker/src/**/*.test.ts",
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
