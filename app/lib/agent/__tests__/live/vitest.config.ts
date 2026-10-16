import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The agent's live eval — `npm run eval:agent`. Never part of `npm test`: it
 * reaches a real model, needs a key, and spends free-tier quota. The hermetic
 * suite in the root vitest.config.ts stays hermetic.
 *
 * It uses the app's own Gemini pool (VITE_GEMINI_API_KEY in .env, or in the
 * environment, which wins); AGENT_EVAL_RESEARCH_MODEL / _RESPONSE_MODEL
 * override a role for one run. A4: AGENT_EVAL_REPEATS=3 runs each scenario
 * three times for pass^3; AGENT_EVAL_ABLATE=find_shade_spots withholds a tool
 * (declaration and prompt mentions); A4b: AGENT_EVAL_TEMPERATURE=1 overrides the app's 0.
 */
export default defineConfig(() => {
  return {
    // Repo root, so `.env` (the key pool) and the include glob resolve as before the move.
    root: fileURLToPath(new URL("../../../../../", import.meta.url)),
    test: {
      environment: "node",
      include: ["app/lib/agent/__tests__/live/**/*.eval.ts"],
      testTimeout: 10 * 60_000,
      hookTimeout: 60_000,
      env: {
        AGENT_EVAL_ONLY: process.env.AGENT_EVAL_ONLY ?? "",
        AGENT_EVAL_OUT: process.env.AGENT_EVAL_OUT ?? "",
        AGENT_EVAL_RESEARCH_MODEL: process.env.AGENT_EVAL_RESEARCH_MODEL ?? "",
        AGENT_EVAL_RESPONSE_MODEL: process.env.AGENT_EVAL_RESPONSE_MODEL ?? "",
        // A4: pass^k repeats, tool ablation, and the shade-data origin.
        AGENT_EVAL_REPEATS: process.env.AGENT_EVAL_REPEATS ?? "",
        AGENT_EVAL_ABLATE: process.env.AGENT_EVAL_ABLATE ?? "",
        AGENT_EVAL_TEMPERATURE: process.env.AGENT_EVAL_TEMPERATURE ?? "",
        ...(process.env.AGENT_EVAL_NAVIGATION_BASE
          ? { AGENT_EVAL_NAVIGATION_BASE: process.env.AGENT_EVAL_NAVIGATION_BASE }
          : {}),
      },
    },
  };
});
