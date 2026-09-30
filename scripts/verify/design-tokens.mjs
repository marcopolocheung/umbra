#!/usr/bin/env node
// Umbra redesign 2.0 registry gate. --all scans app/; --files checks added lines.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, extname } from "node:path";
import { pathToFileURL } from "node:url";

const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|rgba?\s*\([^)]*\)/g;
const ARBITRARY_RE = /(?:rounded|text|leading|w-|h-|min-w-|max-w-|min-h-|max-h-|p[xtbyrl]?-|m[xtbyrl]?-|gap-|top-|bottom-|left-|right-|size-|space-)\[[0-9]+(?:\.[0-9]+)?(?:px|rem|em|vh|vw)\]|rounded-\[[^\]]*\]/g;
const RADIUS_RE = /\b(?:border-radius|borderRadius)\s*:\s*([^{;\n}"'`]+|["'`][^"'`]+["'`])/g;
const SHADOW_RE = /\b(?:box-shadow|boxShadow)\s*:\s*([^{;\n}"'`]+|["'`][^"'`]+["'`])/g;
const ARBITRARY_SHADOW_RE = /(?:drop-)?shadow-\[[^\]\n]+\]/g;
const ROTATE_VALUE_RE = /\brotate\s*:\s*["'`]?\s*-?\d+(?:\.\d+)?(?:deg|rad|turn)\b/g;
const ROTATE_FUNCTION_RE = /(?<![.\w])rotate\(\s*-?\d+(?:\.\d+)?(?:deg|rad|turn)\s*\)/g;
const ROTATE_CLASS_RE = /(?<![\w-])-?rotate-(?:\d+|\[[^\]]+\])(?![\w-])/g;

export function registryLiterals(css) {
  const allowed = new Set();
  for (const declaration of css.matchAll(/--[a-z0-9-]+\s*:\s*([^;{}]+);/gi)) {
    for (const literal of declaration[1].matchAll(COLOR_RE)) allowed.add(literal[0].toLowerCase());
  }
  return allowed;
}

function stripComments(line) {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/(^|\s)\/\/.*$/, " ");
}

function validRegistryValue(value, allowZero = true) {
  const v = value.trim().replace(/^["'`]|["'`]$/g, "").trim();
  return v.startsWith("var(") || (allowZero && /^(?:0|none)$/.test(v));
}

export function scanLine(source, allowed, scanColors = true) {
  if (/^\s*\*/.test(source)) return []; // Interior of a block comment.
  const line = stripComments(source);
  const findings = [];
  if (scanColors) {
    for (const match of line.matchAll(COLOR_RE)) {
      if (!allowed.has(match[0].toLowerCase())) findings.push(`off-registry colour ${match[0]}`);
    }
  }
  for (const match of line.matchAll(ARBITRARY_RE)) findings.push(`arbitrary value ${match[0]} outside the token scale`);
  for (const match of line.matchAll(RADIUS_RE)) {
    if (!validRegistryValue(match[1])) findings.push(`literal radius ${match[1].trim()}`);
  }
  for (const match of line.matchAll(SHADOW_RE)) {
    if (!validRegistryValue(match[1])) findings.push(`literal shadow ${match[1].trim()}`);
  }
  for (const match of line.matchAll(ARBITRARY_SHADOW_RE)) findings.push(`arbitrary shadow ${match[0]} outside the token scale`);
  if (/drop-shadow\s*\(/.test(line)) findings.push("literal drop-shadow outside the registry");
  for (const match of line.matchAll(ROTATE_VALUE_RE)) findings.push(`literal rotation ${match[0]}`);
  for (const match of line.matchAll(ROTATE_FUNCTION_RE)) findings.push(`literal rotation ${match[0]}`);
  for (const match of line.matchAll(ROTATE_CLASS_RE)) findings.push(`literal rotation class ${match[0]}`);
  return findings;
}

function addedLines(root, file) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: root, stdio: "pipe" });
  } catch {
    return null; // untracked: scan whole file
  }
  const diff = execFileSync("git", ["diff", "-U0", "HEAD", "--", file], { cwd: root, encoding: "utf8" });
  const lines = [];
  let next = 0;
  for (const row of diff.split("\n")) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (row.startsWith("+") && !row.startsWith("+++")) lines.push({ number: next++, text: row.slice(1) });
  }
  return lines;
}

function run() {
  const root = process.env.UMBRA_ROOT || execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const css = readFileSync(join(root, "app", "globals.css"), "utf8");
  const allowed = registryLiterals(css);
  const args = process.argv.slice(2);
  const all = args.includes("--all") || !args.includes("--files");
  const files = [];
  if (all) {
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|css)$/.test(name)) files.push(p);
      }
    };
    walk(join(root, "app"));
  } else {
    const start = args.indexOf("--files") + 1;
    for (const arg of args.slice(start)) {
      if (arg.startsWith("--")) break;
      const p = resolve(arg);
      if (existsSync(p) && /\.(ts|tsx|css)$/.test(p) && relative(root, p).startsWith("app/")) files.push(p);
    }
  }
  const findings = [];
  for (const file of files) {
    if (file === join(root, "app", "globals.css")) continue;
    const rel = relative(root, file);
    // Map rendering constants and fixtures have their own colour contracts.
    const scanColors = extname(file) !== ".ts" || !(
      rel.includes("/__tests__/") ||
      rel.startsWith("app/lib/") ||
      rel === "app/hooks/useRouting.ts"
    );
    const lines = all ? null : addedLines(root, rel);
    const rows = lines ?? readFileSync(file, "utf8").split("\n").map((text, i) => ({ number: i + 1, text }));
    for (const row of rows) {
      for (const message of scanLine(row.text, allowed, scanColors)) findings.push(`${rel}:${row.number}: ${message}`);
    }
  }
  if (findings.length) {
    for (const finding of findings) console.log(finding);
    console.log(`design-tokens: ${findings.length} finding(s)`);
    process.exitCode = 1;
  } else console.log(`design-tokens: clean ${all ? "across app/" : "for changed lines"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();
