#!/usr/bin/env node
// Design-token registry lint.
//
// The registry = every custom-property VALUE declared in app/globals.css. A colour literal
// (hex or rgb(a)) used anywhere else is a violation until it is promoted to a token there.
// Radii and dimensions pasted as Tailwind arbitrary values (`-[...]`) are violations too —
// they should come from the scale. The goal state (post-Track-U2) is: this exits 0 with
// `--all`.
//
// Modes:
//   --all              scan every .tsx/.css under app/ (inventory mode; exits 1 while any
//                      violation exists anywhere — pre-U2 that is the expected state)
//   --files a b …      scan the lines those files ADD relative to HEAD (untracked files
//                      fall back to a whole-file scan). This is what the PostToolUse hook
//                      uses, so it reports only what the current edit introduced.
//
// Comments are stripped before scanning, so issue-number references ("(#349)")
// don't masquerade as hex colours; applied styles only.
//
// Never edits anything. Exit 0 = no violations in scope.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.env.UMBRA_ROOT || execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim();
const cssPath = join(root, "app", "globals.css");

const COLOR_RE = /(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\s*\([^)]*\))/g;
const HEX_RE = /#[0-9a-fA-F]{3,4}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b/g;
const ARBITRARY_RE = /(?:rounded|text|leading|w-|h-|min-w-|max-w-|min-h-|max-h-|p[xtbyrl]?-|m[xtbyrl]?-|gap-|top-|bottom-|left-|right-|size-|space-)\[[0-9]+(?:\.[0-9]+)?(?:px|rem|em|vh|vw)\]|rounded-\[[^\]]*\]/g;

function registryLiterals() {
  if (!existsSync(cssPath)) return new Set();
  const css = readFileSync(cssPath, "utf8");
  const allowed = new Set();
  for (const line of css.split("\n")) {
    const m = line.match(/--[a-z0-9-]+\s*:\s*([^;{]+)/i);
    if (!m) continue;
    const value = m[1].trim();
    if (HEX_RE.test(value)) allowed.add(value.match(HEX_RE)[0].toLowerCase());
    if (/rgba?\(/.test(value)) allowed.add(value.match(/rgba?\([^)]*\)/)[0].toLowerCase());
  }
  return allowed;
}

function stripComments(line) {
  return line.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function scanLine(line) {
  line = stripComments(line);
  const findings = [];
  for (const m of line.matchAll(COLOR_RE)) {
    const lit = m[0].toLowerCase();
    if (!registry.has(lit)) findings.push(`off-registry colour ${m[0]}`);
  }
  for (const m of line.matchAll(ARBITRARY_RE)) {
    findings.push(`arbitrary value ${m[0]} outside the token scale`);
  }
  return findings;
}

function scanFile(path) {
  const src = readFileSync(path, "utf8").split("\n");
  const out = [];
  src.forEach((line, i) => {
    for (const f of scanLine(line)) out.push(`${path}:${i + 1}: ${f}`);
  });
  return out;
}

function addedLines(file) {
  let lsStatus = 0;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], { stdio: "pipe" });
  } catch (e) {
    lsStatus = e.status ?? -1;
  }
  const untracked = lsStatus !== 0;
  if (untracked) return { whole: true };
  let diff;
  try {
    diff = execFileSync("git", ["diff", "-U0", "HEAD", "--", file], { encoding: "utf8" });
  } catch {
    return { whole: false, lines: [] };
  }
  const lines = [];
  let addedAt = 0;
  for (const l of diff.split("\n")) {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { addedAt = Number(h[1]); continue; }
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+") && !l.startsWith("+++(")) {
      lines.push({ n: addedAt, text: l.slice(1) });
      addedAt += 1;
    }
  }
  return { whole: false, lines };
}

const registry = registryLiterals();
const scopes = [];
const args = process.argv.slice(2);
let all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--all") all = true;
  else if (args[i] === "--files") { i++; while (i < args.length && !args[i].startsWith("--")) scopes.push(args[i++]); i--; }
}

const findings = [];

if (!all && scopes.length > 0) {
  for (const file of scopes) {
    const abs = resolve(file);
    const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : file;
    if (!existsSync(abs)) continue;
    const { whole, lines } = addedLines(abs);
    if (whole) {
      for (const f of scanFile(abs)) findings.push(f.replace(abs, rel));
    } else {
      for (const l of lines) {
        for (const f of scanLine(l.text)) findings.push(`${rel}:${l.n}: ${f}`);
      }
    }
  }
} else {
  const app = join(root, "app");
  if (!existsSync(app)) process.exit(0);
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = p.startsWith(root) ? p.slice(root.length + 1) : p;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(tsx|css)$/.test(name)) findings.push(...scanFile(rel));
    }
  };
  walk(app);
}

if (findings.length === 0) {
  console.log(`design-tokens: clean${all ? " across app/" : " for changed lines"}`);
  process.exit(0);
}
for (const f of findings) console.log(f);
console.log(`design-tokens: ${findings.length} finding(s). Registry literals live in app/globals.css — promote the value to a token there, or use the scale.`);
process.exit(1);
