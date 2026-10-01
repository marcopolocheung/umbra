import { COIN_RADIUS } from "../lib/lineBadges";
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

export interface LineCoinParts {
  /** The marker element: a zero-size anchor on the line where the coin sits. */
  host: HTMLDivElement;
  /** The weld's mask lives here: the ride as drawn, minus the stops on it. */
  defs: SVGDefsElement;
  /** The welded joint's group, masked to the ride and away from its stops. */
  joint: SVGGElement;
  casing: SVGPathElement;
  fill: SVGPathElement;
  /** The coin's own disc, never masked, so a dragged coin passes in front of a stop. */
  disc: SVGCircleElement;
  /** The 44px drag target over the coin, carrying the letter. */
  grip: HTMLDivElement;
}

let coinIds = 0;

/**
 * A transit line's coin welded into its drawn ride (#149, the owner's "pressure
 * bulb" with study 6's keyline): the line's own colour runs from the ride into
 * the coin through concave fillets, wrapped in one paper casing, so the letter
 * reads as part of the line rather than a sticker on it. The geometry is drawn
 * each frame by `lineCoinMarker` (`weldOutline`); this builds the empty parts.
 *
 * The host is a zero-size anchor on the line: the joint and disc are an SVG
 * around it that never takes the pointer, and the only hit target is the 44px
 * grip riding on the coin. The letter takes whichever ink `lineBulletInk` reads
 * at 4.5:1 on the line's colour, or sits on a cream disc where neither does.
 * DOM only, never the map canvas, so the shadow sampler cannot see it (#5).
 */
export function lineCoinElement(line: string, color: string): LineCoinParts {
  const css = lineCssColor(color);
  const ink = lineBulletInk(css);
  const id = `line-coin-${++coinIds}`;
  const host = document.createElement("div");
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", `Line ${line}`);
  host.dataset.line = line;
  host.style.cssText = "width:0;height:0;position:relative;";

  const svgNs = "http://www.w3.org/2000/svg";
  const make = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) => {
    const el = document.createElementNS(svgNs, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const svg = make("svg", { width: "160", height: "160", viewBox: "-80 -80 160 160", "aria-hidden": "true" });
  svg.style.cssText = "position:absolute;left:-80px;top:-80px;overflow:visible;pointer-events:none;";
  const defs = make("defs", {});
  defs.appendChild(make("mask", { id: `${id}-ride`, maskUnits: "userSpaceOnUse", x: "-200", y: "-200", width: "400", height: "400" }));
  const joint = make("g", { mask: `url(#${id}-ride)`, "data-part": "joint" });
  const casing = make("path", {
    fill: "none", stroke: "var(--color-map-casing)", "stroke-width": "3",
    "stroke-linecap": "butt", "stroke-linejoin": "round", "data-part": "casing",
  });
  const fill = make("path", { fill: css, "data-part": "weld" });
  joint.append(casing, fill);
  const disc = make("circle", { r: String(COIN_RADIUS), fill: css, "data-part": "coin" });
  svg.append(defs, joint, disc);
  host.appendChild(svg);

  const grip = document.createElement("div");
  grip.dataset.part = "grip";
  grip.style.cssText = `
    position:absolute;left:-22px;top:-22px;width:44px;height:44px;cursor:grab;touch-action:none;
    pointer-events:auto;display:flex;align-items:center;justify-content:center;
  `;
  const letter = document.createElement("span");
  letter.style.cssText = `
    font-family:var(--font-label);font-size:${line.length > 2 ? 11 : 13}px;font-weight:800;line-height:1;
    font-variant-numeric:tabular-nums;color:var(--color-line-ink-${ink ?? "dark"});
    ${ink ? "" : "background:var(--color-line-ink-light);border-radius:var(--radius-full);padding:4px 5px;"}
  `;
  letter.textContent = line;
  grip.appendChild(letter);
  host.appendChild(grip);
  return { host, defs, joint, casing, fill, disc, grip };
}

/**
 * The name beside a ride's board or exit stop: a small paper plate in the map's
 * overlay inks (it follows the basemap theme), the two stops a rider acts on.
 * Not a control, so it lets the map keep its gestures.
 */
export function stopLabelElement(name: string): HTMLDivElement {
  const label = document.createElement("div");
  label.dataset.part = "stop-label";
  label.textContent = name;
  label.style.cssText = `
    pointer-events:none;white-space:nowrap;padding:2px 6px;
    font-family:var(--font-body);font-size:11px;font-weight:600;line-height:1.3;
    background:var(--color-map-casing);color:var(--color-map-route);
    border:1.5px solid var(--color-map-route);border-radius:var(--radius-sm);
    box-shadow:var(--shadow-map-marker);
  `;
  return label;
}
