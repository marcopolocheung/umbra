/**
 * Which ink a transit line bullet's identifier takes on the line's own colour.
 *
 * Lines arrive with their published colour (`RouteLeg.lineColor`), and the
 * bullet fills with it so the card names the line the map draws. The
 * identifier on that fill must still read, so it takes whichever registry ink
 * — the line-bullet near-black or the day panel cream — has the higher WCAG
 * contrast against it. White replaces cream where cream narrowly misses 4.5:1,
 * as on the 7's purple and the J/Z brown. `null` when no ink reaches 4.5:1
 * or the colour is not a hex value (an OSM `colour=red`, say): the caller then
 * rings the identifier in the line's colour instead of filling behind it.
 */

const DARK = "#0b0b0b";
const LIGHT = "#f8efdf";
const WHITE = "#ffffff";
const MIN_TEXT_CONTRAST = 4.5;

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A line colour CSS will accept: OSM `colour` may arrive as bare hex. */
export function lineCssColor(color: string): string {
  return /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? `#${color}` : color;
}

export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function lineBulletInk(lineColor: string): "dark" | "light" | "white" | null {
  const dark = contrastRatio(lineColor, DARK);
  const light = contrastRatio(lineColor, LIGHT);
  if (dark == null || light == null) return null;
  if (Math.max(dark, light) < MIN_TEXT_CONTRAST) {
    const white = contrastRatio(lineColor, WHITE);
    return white != null && white >= MIN_TEXT_CONTRAST ? "white" : null;
  }
  return dark >= light ? "dark" : "light";
}
