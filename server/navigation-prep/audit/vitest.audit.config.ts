import { defineConfig } from "vitest/config";

// The independent shade audit (#294) — run by hand only; see shadeAudit.audit.ts.
export default defineConfig({
  test: {
    include: ["server/navigation-prep/audit/*.audit.ts"],
    environment: "node",
    testTimeout: 24 * 3600_000,
  },
});
