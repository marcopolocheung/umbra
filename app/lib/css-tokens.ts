/**
 * Strata token values for JavaScript-side consumers (MapLibre paint properties,
 * markers, canvas/SVG elements and tests) that cannot reference `var(--…)`.
 *
 * The registry is `app/globals.css` and nothing here re-declares a value: this
 * module parses the CSS source at bundle time (`?raw`) so a colour exists exactly
 * once, in the token registry. Changing a token in globals.css changes it here.
 *
 * `token(name)` throws when a name is missing — a token reference only survives
 * in code if it is declared in the registry.
 */

import registryCss from "../globals.css?raw";

const TOKEN_RE = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
// `@theme` emits tokens as plain declarations; colours use hex or `rgba(...)`.
const registry = new Map<string, string>();

for (const match of registryCss.matchAll(TOKEN_RE)) {
  const name = match[1];
  const value = match[2].trim();
  if (!registry.has(name)) registry.set(name, value);
}

export function token(name: string): string {
  const value = registry.get(name);
  if (value === undefined) {
    throw new Error(`Strata token --${name} is not declared in app/globals.css`);
  }
  return value;
}

/** `color-mix(in srgb, var(--color-x) <pct>%, transparent)` — an alpha wash of a token. */
export function tokenWash(name: string, percent: number): string {
  return `color-mix(in srgb, var(--${name}) ${percent}%, transparent)`;
}
