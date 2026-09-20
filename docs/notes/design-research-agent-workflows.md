# Design research (b) — keeping AI sessions consistent on design

**Bounded question:** what is current agent-workflow practice for keeping AI coding sessions consistent on a design language?

**Answer.** The converged practice (2025→2026) is a three-layer stack: (1) a durable spec doc the agent reads every session (CLAUDE.md / AGENTS.md / a language doc it is pointed at), (2) progressive, design-scoped skills and MCP servers that load only when relevant, and (3) deterministic hooks and lints that fail output the agent cannot argue with. Session prompts change; the spec file and the lint do not. Screenshot round-trips (render → compare → fix) are the emerging verification idiom.

**Verified (primary sources, accessed 2026-09-20):**

- Claude Code memory docs: `CLAUDE.md`/`AGENTS.md` tiers are "persistent instructions ... Claude reads at the start of every session"; guidance: "Add to it when ... you'd otherwise re-explain" — https://code.claude.com/docs/en/memory.
- Claude Code hooks: `PreToolUse` hooks can block destructive/off-policy edits; engineering guidance contrasts them with CLAUDE.md: "Unlike CLAUDE.md instructions which are advisory, hooks are deterministic and guarantee the action happens" — https://code.claude.com/docs/en/hooks, https://www.anthropic.com/engineering/claude-code-best-practices.
- Anthropic's Agent Skills addition: "Skills are folders that include instructions, scripts, and resources that Claude can load when needed ... to improve how it performs specific tasks" — the announcement's motivating example is literally "following your organization's brand guidelines"; progressive discovery keeps context small — https://claude.com/blog/skills (published 2025-10).
- Claude Code skills frontmatter supports design this needs: `description` incl. "when to use", `allowed-tools`, `model`/`effort` overrides, `hooks`, and path `globs` limiting auto-activation to matching files — https://code.claude.com/docs/en/skills. Subagents and plugin bundles (skills+hooks+subagents+MCP in one unit) complete the stack — https://code.claude.com/docs/en/sub-agents.
- The screenshot loop is official guidance: "[paste screenshot] implement this design. take a screenshot of the result and compare it to the original. list differences and fix them" — https://www.anthropic.com/engineering/claude-code-best-practices.
- `agents.md` emerged as the cross-tool standard for durable project instructions that AI agents read at session start — https://agents.md/.
- Design systems are now distributed agent-first: shadcn/ui positions itself "AI-Ready", publishes `llms.txt`, a Claude-Code skill (`npx skills add shadcn/ui`) that reads the project's `components.json`, and an MCP server for "browse, search, and install components from registries" — https://ui.shadcn.com/docs/skills, https://ui.shadcn.com/llms.txt.
- Figma ships a Dev-Mode MCP server so agents read real design files instead of prose descriptions — https://developers.figma.com/docs/figma-mcp-server/.
- GitHub Primer embeds agent-oriented design docs in the token repo itself: `AGENTS.md` pointing at `DESIGN_TOKENS_GUIDE.md` (semantic-token rule, pairing matrix, contrast floors) and per-token `org.primer.llm` metadata — https://github.com/primer/primitives (accessed 2026-09-20).
- Umbra's own U0 harness instantiates the stack: path-scoped `.claude/rules/design-language.md` (advisory until U2), token lint + `lint-changed` hook, shot runner, and an `interface-reviewer` agent with a design-language section — `.claude/` in this repo (merged PR #465, 2026-09-19).

**Inferred.** The durable design spec, not the session prompt, is where the language actually lives; generated-artifact checks (lint/screenshots) drift less than prompts; skills with path globs keep design rules out of unrelated sessions' context. Umbra is already on this path — the missing piece is the canonical `docs/design/language.md` that U1→U2 creates.

**What this changes for Umbra.** After owner sign-off, `docs/design/language.md` becomes the memory tier the rules/hooks already reference, so U2–U6 sessions inherit the language from one file rather than re-deriving it; the U1 decision doc can be written to make that canonical file nearly mechanical to produce.
