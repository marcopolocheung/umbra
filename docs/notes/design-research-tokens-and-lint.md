# Design research (a) — encoding a design system so a lint can enforce it

**Bounded question:** how do shipping teams encode a design system so a lint can check it?

**Answer.** The pattern that has survived contact with shipping: one machine-readable token file (JSON/JSON5 per the W3C DTCG format) as the source of truth, generated CSS variables registered in a single stylesheet, a semantic naming model (role > palette > vividness, never "yellow-500" in components), and lint rules that ban raw values per property. The bans live in the same repo as the tokens so drift fails CI, not reviews.

**Verified (fetched primary sources, accessed 2026-09-20):**

- Design tokens were created by the Salesforce design system team; the W3C Design Tokens Community Group publishes the interoperable format as Technical Reports (`format`, `color`, `resolver` modules) — still a preview draft, "do not implement this version" — https://tr.designtokens.org/ (bundle dated 2025-10).
- `design-tokens/validator` is a checker that validates files against the DTCG format spec — https://github.com/design-tokens/validator.
- Style Dictionary (npm latest 5.5.4) is the reference build: "A build system for creating cross-platform styles" from token JSON — https://styledictionary.com/.
- GitHub Primer Primitives stores tokens as JSON5 (`$value`, `$type`, `$description`, `$extensions` incl. `org.primer.llm` guidelines) and generates `DESIGN_TOKENS_SPEC.md` — https://github.com/primer/primitives (DESIGN_TOKENS_GUIDE.md, AGENTS.md). Its core rule, verbatim: "You are a CSS expert. Never use raw values (hex, px, etc.). Only use semantic tokens." plus a required pairing matrix (bg/fg roles) and WCAG contrast floors (4.5:1 text, 3:1 UI).
- GitHub Primer lints tokens in-repo: `primer/stylelint-config` ships custom Stylelint rules `primer/colors`, `primer/spacing`, `primer/typography`, `primer/no-display-colors` (alpha tokens "should be used ... with approval from the Primer team") — https://github.com/primer/stylelint-config.
- Shopify's `@shopify/stylelint-polaris` plugin enforces "Please use a Polaris color/space/shadow/motion/z-index token" per rule; the Polaris repo dogfoods it in `.stylelintrc.js` — https://github.com/Shopify/polaris/tree/main/stylelint-polaris.
- Atlassian ships `stylelint-design-system` as a component ("write a stylelint rule that defines what success looks like for your system") — https://atlassian.design/components/stylelint-design-system.
- Stylelint core ships `color-no-hex` and `function-disallowed-list` for exactly this ban — https://stylelint.io/user-guide/rules/color-no-hex/.
- Tailwind v4 registers tokens in CSS via `@theme` (one stylesheet as registry) — https://tailwindcss.com/docs/theme.
- Practitioner walkthroughs of the same pattern: css-architecture.com "Writing custom stylelint rules for token usage" and designsystemproblems.com "Component drift → stylelint design-system rules" (secondary sources; consistent with the primaries above).

**Inferred (synthesis, not quoted).** The winning shape is: semantic tokens only in component code (role, not hue), raw values only in the registry, continuous enforcement via lint + a build step that emits the variables, and a human-readable spec doc generated from (not parallel to) the token file. Umbra's U0 harness (`scripts/verify/design-tokens.mjs`, `lint-changed` hook) is the same shape as the Primer/Shopify pattern.

**What this changes for Umbra.** U2 should register the chosen palette as semantic tokens in `app/globals.css` (Tailwind `@theme`), then tighten `design:check` to ban raw colors/arbitrary radii the way `primer/colors` + `color-no-hex` do; doc-based descriptions are the stopgap, lint is the enforcement.
