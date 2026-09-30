import { COIN_RADIUS, coinOutline } from "../lib/lineBadges";
import { lineBulletInk, lineCssColor } from "../lib/lineBulletInk";

/**
 * Umbra redesign 2.0 R4b map pins: one teardrop, two fills, never colour alone.
 *
 * `filled` (ink by day, cream by night) marks where a trip goes — the destination and
 * the assistant's numbered stops. `hollow` (paper fill, ink ring) marks where it starts
 * and the points a sketch passes through. The letter or number says which is which;
 * the fill is a second cue, not the only one. Colours are the `--color-map-*` aliases,
 * so a pin follows the basemap (solar) theme by cascade, not the UI override.
 *
 * The host is a square 44px hit area (touch-target floor); only the visual teardrop
 * inside it is rotated, so the target itself never tilts. Anchor the marker at
 * `"bottom"`: the teardrop's tip sits at the host's bottom centre.
 */
export type MapPinVariant = "filled" | "hollow";

export function mapPinElement(variant: MapPinVariant, label: string, text = ""): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("aria-label", label);
  host.style.cssText = `
    width:44px;height:44px;display:flex;align-items:flex-end;justify-content:center;cursor:pointer;
  `;

  const [fill, ink] = variant === "filled"
    ? ["var(--color-map-route)", "var(--color-map-casing)"]
    : ["var(--color-map-casing)", "var(--color-map-route)"];
  const pin = document.createElement("div");
  pin.style.cssText = `
    width:26px;height:26px;margin-bottom:6px;border-radius:var(--radius-pin);
    transform:rotate(var(--angle-marker));
    background:${fill};border:2px solid ${ink};box-shadow:var(--shadow-map-marker);
    display:flex;align-items:center;justify-content:center;
  `;
  if (text) {
    const inner = document.createElement("span");
    inner.style.cssText = `
      transform:rotate(var(--angle-marker-inner));font-family:var(--font-numeric);
      font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;color:${ink};
    `;
    inner.textContent = text;
    pin.appendChild(inner);
  }
  host.appendChild(pin);
  return host;
}

/**
 * A transit line's identifier as a coin threaded on its drawn ride (#149): the
 * line's published colour inside a hand-inked rim (`coinOutline`, seeded by the
 * line), the letter in whichever ink `lineBulletInk` measures readable on that
 * colour. Where neither reaches 4.5:1 (the 7's purple, the J/Z brown) the letter
 * sits on a cream disc inside the coloured coin instead. The rim and letter inks
 * are the theme-fixed line-bullet inks, so the coin reads the same on both maps.
 *
 * The host is the 44px grip — maplibre re-enables pointer events on its marker
 * element after every press, so the host must be exactly the target. A DOM
 * marker, never a canvas layer, so the shadow sampler cannot see it (#5).
 */
export function lineCoinElement(line: string, color: string): HTMLDivElement {
  const css = lineCssColor(color);
  const ink = lineBulletInk(css);
  // A three-character route (a bus such as the M15) needs a wider coin at the 11px floor.
  const radius = line.length > 2 ? COIN_RADIUS + 4 : COIN_RADIUS;
  const host = document.createElement("div");
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", `Line ${line}`);
  host.dataset.line = line;
  host.style.cssText = `
    width:44px;height:44px;position:relative;cursor:grab;touch-action:none;
    display:flex;align-items:center;justify-content:center;
  `;

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "-22 -22 44 44");
  svg.setAttribute("width", "44");
  svg.setAttribute("height", "44");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;inset:0;overflow:visible;pointer-events:none;";
  const coin = document.createElementNS(svgNs, "path");
  coin.setAttribute("d", coinOutline(line, radius));
  coin.setAttribute("fill", css);
  coin.setAttribute("stroke", "var(--color-line-ink-dark)");
  coin.setAttribute("stroke-width", "3");
  coin.setAttribute("stroke-linejoin", "round");
  coin.setAttribute("data-part", "coin");
  svg.appendChild(coin);
  if (!ink) {
    const disc = document.createElementNS(svgNs, "circle");
    disc.setAttribute("r", String(radius - 5));
    disc.setAttribute("fill", "var(--color-line-ink-light)");
    disc.setAttribute("data-part", "disc");
    svg.appendChild(disc);
  }
  host.appendChild(svg);

  const letter = document.createElement("span");
  letter.style.cssText = `
    position:relative;font-family:var(--font-label);font-size:${line.length > 2 ? 11 : 13}px;
    font-weight:800;line-height:1;font-variant-numeric:tabular-nums;
    color:var(--color-line-ink-${ink ?? "dark"});
  `;
  letter.textContent = line;
  host.appendChild(letter);
  return host;
}
