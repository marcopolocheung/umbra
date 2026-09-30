import { BLOB_HALF_LENGTH, blobOutline } from "../lib/lineBadges";
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
 * A transit line's identifier as a swelling of its own drawn ride (#149): an
 * irregular bulge (`blobOutline`, seeded by the line) in the line's published
 * colour with no outline, whose ends thin to the line's exact width so it reads
 * as the line thickening rather than a pin set on it. The letter stays upright
 * while the swelling turns with the track (`orientLineBlob`), and takes the ink
 * `lineBulletInk` measures readable on that colour; where neither reaches 4.5:1
 * it sits on a small casing disc instead.
 *
 * Only a 44px disc at the centre catches the pointer (it is draggable along the
 * ride); the rest of the host lets the map keep its gestures. A DOM marker, never
 * a canvas layer, so the shadow sampler's readback cannot see it (invariant #5).
 */
export function lineBlobElement(line: string, color: string): HTMLDivElement {
  const css = lineCssColor(color);
  const ink = lineBulletInk(css);
  const size = BLOB_HALF_LENGTH * 2;
  const host = document.createElement("div");
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", `Line ${line}`);
  host.dataset.line = line;
  host.style.cssText = `width:${size}px;height:${size}px;position:relative;pointer-events:none;`;

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `${-BLOB_HALF_LENGTH} ${-BLOB_HALF_LENGTH} ${size} ${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;inset:0;overflow:visible;pointer-events:none;";
  const blob = document.createElementNS(svgNs, "path");
  blob.setAttribute("d", blobOutline(line));
  blob.setAttribute("fill", css);
  blob.setAttribute("data-part", "blob");
  svg.appendChild(blob);
  host.appendChild(svg);

  const grip = document.createElement("div");
  grip.dataset.part = "grip";
  grip.style.cssText = `
    position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;
    border-radius:var(--radius-circle);pointer-events:auto;cursor:grab;touch-action:none;
    display:flex;align-items:center;justify-content:center;
  `;
  const letter = document.createElement("span");
  letter.style.cssText = `
    font-family:var(--font-label);font-size:11px;font-weight:800;line-height:1;
    font-variant-numeric:tabular-nums;color:${ink ? `var(--color-line-ink-${ink})` : "var(--color-map-route)"};
    ${ink ? "" : "background:var(--color-map-casing);border-radius:var(--radius-full);padding:3px 5px;"}
  `;
  letter.textContent = line;
  grip.appendChild(letter);
  host.appendChild(grip);
  return host;
}

/** Turns the swelling to lie along the track; the letter stays upright. */
export function orientLineBlob(host: HTMLElement, angleDeg: number): void {
  const svg = host.querySelector("svg");
  if (svg) svg.style.rotate = `${angleDeg}deg`;
}
