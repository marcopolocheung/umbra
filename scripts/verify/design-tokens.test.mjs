import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { registryLiterals, scanLine } from "./design-tokens.mjs";

const allowed = registryLiterals('--color-ink: #1b1512; --shadow-hard: 2px 2px 0 #1b1512;');
const check = (line, scanColors) => scanLine(line, allowed, scanColors);

test("registry colours and named geometry pass", () => {
  assert.deepEqual(check('style={{ color: "#1b1512", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-hard-1)", rotate: "var(--angle-label)" }}'), []);
  assert.deepEqual(check('map.rotate(45);'), []);
  assert.deepEqual(check('className="shadow-hard-2"'), []);
  assert.deepEqual(check(' * an example colour (`#ff00ff`) in a block comment'), []);
});

test("off-registry colours, radii, rotations, and shadows fail", () => {
  assert.match(check('color: "#ffffff"')[0], /colour/);
  assert.match(check('const style = { color: "#ff00ff" }')[0], /colour/);
  assert.deepEqual(check('const mapDataColor = "#ff00ff"', false), []);
  assert.match(check('borderRadius: 8')[0], /radius/);
  assert.match(check('className="rounded-[18px]"')[0], /arbitrary/);
  assert.match(check('transform:rotate(45deg)')[0], /rotation/);
  assert.match(check('className="rotate-90"')[0], /rotation/);
  assert.match(check('boxShadow: "0 0 6px blue"')[0], /shadow/);
  assert.match(check('className="shadow-[0_4px_8px_black]"')[0], /arbitrary shadow/);
  assert.match(check('className="drop-shadow-[0_2px_4px_black]"')[0], /arbitrary shadow/);
  assert.match(check('filter:drop-shadow(0 2px 4px black)')[0], /drop-shadow/);
});

test("issue references in line and multiline JSX comments are ignored", () => {
  const state = { block: false };
  for (const line of [
    'const label = "route"; // issue #160',
    '{/* Map controls (#162)',
    '    issue #161 should never be a colour',
    '*/} <div style={{ color: "#1b1512" }} />',
  ]) assert.deepEqual(scanLine(line, allowed, true, state), []);
  assert.deepEqual(check('it("sunrise edges (#160)", () => {})'), []);
  assert.deepEqual(check('const value = "https://example.com/#160"'), ['off-registry colour #160']);
  assert.match(check('const value = "#f08a5d" // issue #162')[0], /colour #f08a5d/);
});

test("day and night text and essential rules pass on both surfaces", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  const values = (block) => new Map([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1], m[2]]));
  const day = values(css.match(/@theme\s*\{([\s\S]*?)\n\}/)[1]);
  const night = new Map([...day, ...values(css.match(/html\[data-theme="night"\]\s*\{([\s\S]*?)\n\}/)[1])]);
  const luminance = (hex) => {
    const channel = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return channel[0] * 0.2126 + channel[1] * 0.7152 + channel[2] * 0.0722;
  };
  const contrast = (a, b) => {
    const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
    return (high + 0.05) / (low + 0.05);
  };
  for (const [theme, roles] of [["day", day], ["night", night]]) {
    for (const surface of ["color-ground", "color-panel"]) {
      for (const [ink, floor] of [["color-ink", 7], ["color-ink-muted", 4.5], ["color-rule", 3]]) {
        const ratio = contrast(roles.get(ink), roles.get(surface));
        assert.ok(ratio >= floor, `${theme} ${ink} on ${surface}: ${ratio.toFixed(2)} < ${floor}`);
      }
    }
    for (const role of ["route", "sun", "shade", "canopy", "rain", "danger"]) {
      const ratio = contrast(roles.get(`color-${role}`), roles.get(`color-on-${role}`));
      assert.ok(ratio >= 4.5, `${theme} on-${role}: ${ratio.toFixed(2)} < 4.5`);
    }
    const signalRatio = contrast(roles.get("color-sun-signal"), roles.get("color-on-sun-signal"));
    assert.ok(signalRatio >= 4.5, `${theme} sun signal: ${signalRatio.toFixed(2)} < 4.5`);
  }
});

test("registered shadows and drop-shadow have zero blur", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  for (const match of css.matchAll(/--(?:shadow-[a-z0-9-]+|filter-map-pin):\s*([^;]+);/g)) {
    const value = match[1].replace(/^drop-shadow\(/, "");
    const dimensions = value.match(/^(-?\d+(?:px)?)\s+(-?\d+(?:px)?)\s+(-?\d+(?:px)?)/);
    assert.ok(dimensions, `cannot read shadow geometry: ${match[0]}`);
    assert.match(dimensions[3], /^0(?:px)?$/, `blurred shadow: ${match[0]}`);
  }
});
