import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * H7's full report — `npm run eval:h7`. Never part of `npm test`: it solves a
 * few thousand integer programs (minutes). Writes the certificates and the
 * summary `docs/notes/sun-budget-formulation.md` quotes into `docs/notes/h7/`.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../../../../../", import.meta.url)),
  test: {
    environment: "node",
    include: ["app/lib/sunBudgetFormulation/__tests__/eval/**/*.eval.ts"],
    testTimeout: 60 * 60_000,
  },
});
