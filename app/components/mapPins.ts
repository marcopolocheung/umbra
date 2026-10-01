import { COIN_RADIUS } from "../lib/lineBadges";
import { lineBulletInk, lineCssColor, lineWhitePlateFill } from "../lib/lineBulletInk";

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

/** How far the dotted leader runs from a board or exit point to its flag, in px. */
export const STOP_FLAG_LEADER_PX = 34;

function flagShield(line: string, color: string, name: string): HTMLDivElement {
  const css = lineCssColor(color);
  const ink = lineBulletInk(css);
  const shield = document.createElement("div");
  shield.dataset.part = "shield";
  shield.style.cssText = `
    display:flex;align-items:center;gap:6px;height:28px;padding:0 11px 0 3px;white-space:nowrap;
    background:var(--color-line-ink-dark);border:3px solid ${css};border-radius:var(--radius-full);
    box-shadow:var(--shadow-map-marker);
  `;
  const coin = document.createElement("span");
  coin.dataset.part = "line";
  coin.textContent = line;
  coin.style.cssText = `
    display:grid;place-items:center;min-width:20px;height:20px;padding:0 3px;border-radius:var(--radius-full);
    font-family:var(--font-label);font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;
    ${ink ? `background:${css};color:var(--color-line-ink-${ink});` : `background:var(--color-line-ink-light);color:var(--color-line-ink-dark);border:2px solid ${css};`}
  `;
  const label = document.createElement("span");
  label.dataset.part = "stop-name";
  label.textContent = name;
  label.style.cssText = `
    max-width:190px;overflow:hidden;text-overflow:ellipsis;
    font-family:var(--font-display);font-size:14px;font-weight:700;line-height:1;color:var(--color-line-ink-light);
  `;
  shield.append(coin, label);
  return shield;
}

/**
 * A ride's board or exit point as a kicker flag: a dotted leader in the
 * line's colour runs from the door (or stop when no door is known) to a shield — an ink pill ringed in that
 * colour, holding the line's letter coin and the stop's name — under a small
 * tilted plate in the line's colour reading Enter here or Exit here. `toward` is
 * the unit direction (screen px) the flag opens in, away from the ride.
 *
 * The shield's inks are theme-fixed like the line bullets', so it reads the same
 * on both maps; the plate and coin take whichever ink reads at 4.5:1 on the
 * line's colour, using white where cream misses the threshold, or a cream ground ringed in it where neither does. A zero-size
 * anchor at the door or stop that never takes the pointer; DOM only, never the canvas.
 */
export function stopFlagElement(
  kind: "enter" | "exit",
  line: string,
  color: string,
  name: string,
  toward: [number, number],
  door = false,
): HTMLDivElement {
  const css = lineCssColor(color);
  const ink = lineBulletInk(css);
  const kicker = kind === "enter" ? "Enter here" : "Exit here";
  const [px, py] = toward;
  const host = document.createElement("div");
  host.dataset.part = "stop-flag";
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", `${kicker}: ${line}, ${name}`);
  host.style.cssText = "width:0;height:0;position:relative;pointer-events:none;";

  if (door) {
  const dot = document.createElement("span");
    dot.dataset.part = "door";
    dot.style.cssText = `
      position:absolute;z-index:2;left:-5px;top:-5px;width:10px;height:10px;box-sizing:border-box;
      background:var(--color-line-ink-dark);border:2px solid ${css};border-radius:var(--radius-circle);
      box-shadow:var(--shadow-map-marker);
    `;
    host.appendChild(dot);
  }

  // The leader: round dots from just outside the door dot or stop ring to the flag.
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", "1");
  svg.setAttribute("height", "1");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;";
  const leader = document.createElementNS(svgNs, "path");
  const [from, to] = [door ? 6 : 12, STOP_FLAG_LEADER_PX];
  leader.setAttribute("d", `M${(px * from).toFixed(2)},${(py * from).toFixed(2)}L${(px * to).toFixed(2)},${(py * to).toFixed(2)}`);
  leader.setAttribute("stroke", css);
  leader.setAttribute("stroke-width", "3");
  leader.setAttribute("stroke-linecap", "round");
  leader.setAttribute("stroke-dasharray", "0 6");
  leader.dataset.part = "leader";
  svg.appendChild(leader);
  host.appendChild(svg);

  // The flag opens away from the ride: its nearest corner meets the leader's end.
  const shift = (d: number) => (d > 0.38 ? 0 : d < -0.38 ? -100 : -50);
  const flag = document.createElement("div");
  flag.dataset.part = "flag-body";
  flag.style.cssText = `
    position:absolute;left:${(px * to).toFixed(2)}px;top:${(py * to).toFixed(2)}px;
    transform:translate(${shift(px)}%, ${shift(py)}%);
    display:flex;flex-direction:column;align-items:flex-start;
  `;
  const plate = document.createElement("span");
  plate.dataset.part = "kicker";
  plate.textContent = kicker;
  plate.style.cssText = `
    position:relative;z-index:1;margin:0 0 -3px 10px;padding:2px 7px;white-space:nowrap;
    font-family:var(--font-label);font-size:11px;font-weight:800;letter-spacing:0.06em;
    text-transform:uppercase;line-height:1.3;rotate:var(--angle-flag);clip-path:var(--plate-clip);
    ${ink ? `background:${css};color:var(--color-line-ink-${ink});` : `background:var(--color-line-ink-light);color:var(--color-line-ink-dark);border:2px solid ${css};`}
  `;
  const shield = flagShield(line, color, name);
  shield.dataset.part = "shield";
  flag.append(plate, shield);
  host.appendChild(flag);
  return host;
}

/** A transfer instruction at the last stop of one ride, with both boarding names. */
export function transferFlagElement(
  from: { line: string; color: string; name: string },
  to: { line: string; color: string; name: string },
  toward: [number, number],
): HTMLDivElement {
  const [px, py] = toward;
  const host = document.createElement("div");
  host.dataset.part = "transfer-flag";
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", `Transfer: ${from.line}, ${from.name} to ${to.line}, ${to.name}`);
  host.style.cssText = "width:0;height:0;position:relative;pointer-events:none;";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "1");
  svg.setAttribute("height", "1");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;";
  const leader = document.createElementNS("http://www.w3.org/2000/svg", "path");
  leader.dataset.part = "leader";
  leader.setAttribute("d", `M${(px * 12).toFixed(2)},${(py * 12).toFixed(2)}L${(px * STOP_FLAG_LEADER_PX).toFixed(2)},${(py * STOP_FLAG_LEADER_PX).toFixed(2)}`);
  leader.setAttribute("stroke", lineCssColor(from.color));
  leader.setAttribute("stroke-width", "3");
  leader.setAttribute("stroke-linecap", "round");
  leader.setAttribute("stroke-dasharray", "0 6");
  svg.appendChild(leader);

  const shift = (d: number) => (d > 0.38 ? 0 : d < -0.38 ? -100 : -50);
  const flag = document.createElement("div");
  flag.dataset.part = "flag-body";
  flag.style.cssText = `
    position:absolute;left:${(px * STOP_FLAG_LEADER_PX).toFixed(2)}px;top:${(py * STOP_FLAG_LEADER_PX).toFixed(2)}px;
    transform:translate(${shift(px)}%, ${shift(py)}%);
    display:flex;flex-direction:column;align-items:flex-start;
  `;
  const plate = document.createElement("span");
  plate.dataset.part = "kicker";
  const fromPlate = lineWhitePlateFill(from.color);
  const toPlate = lineWhitePlateFill(to.color);
  const whiteOnGradient = fromPlate !== null && toPlate !== null;
  plate.style.cssText = `
    position:relative;z-index:1;margin:0 0 -3px 10px;padding:2px 7px;white-space:nowrap;
    font-family:var(--font-label);font-size:11px;font-weight:800;letter-spacing:0.06em;
    text-transform:uppercase;line-height:1.3;color:var(--color-line-ink-white);
    rotate:var(--angle-flag);clip-path:var(--plate-clip);
    background:linear-gradient(90deg, ${fromPlate ?? lineCssColor(from.color)}, ${toPlate ?? lineCssColor(to.color)});
  `;
  if (whiteOnGradient) {
    plate.textContent = "Transfer";
  } else {
    const plateText = document.createElement("span");
    plateText.textContent = "Transfer";
    plateText.style.cssText = "display:block;padding:0 3px;background:var(--color-line-ink-dark);color:var(--color-line-ink-white);";
    plate.style.padding = "3px 5px";
    plate.appendChild(plateText);
  }
  const shields = document.createElement("div");
  shields.dataset.part = "shield";
  shields.style.cssText = "display:flex;flex-direction:column;align-items:flex-start;";
  const fromShield = flagShield(from.line, from.color, from.name);
  fromShield.dataset.part = "from-shield";
  const toShield = flagShield(to.line, to.color, to.name);
  toShield.dataset.part = "to-shield";
  toShield.style.marginLeft = "18px";
  const arrow = document.createElement("span");
  arrow.dataset.part = "transfer-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↘";
  arrow.style.cssText = `
    margin:-3px 0 -5px 27px;position:relative;z-index:1;
    font-family:var(--font-label);font-size:18px;font-weight:800;line-height:1;
    color:var(--color-line-ink-light);background:var(--color-line-ink-dark);
    border-radius:var(--radius-circle);padding:0 4px;
  `;
  shields.append(fromShield, arrow, toShield);
  flag.append(plate, shields);
  host.append(svg, flag);
  return host;
}

/** Keep a flag readable inside the map as its door moves on screen. */
export function placeStopFlagElement(
  host: HTMLElement,
  toward: [number, number],
  origin: { x: number; y: number },
  viewport: { width: number; height: number },
  door = false,
): void {
  const [px, py] = toward;
  const offscreen = origin.x < 0 || origin.x > viewport.width || origin.y < 0 || origin.y > viewport.height;
  host.style.display = offscreen ? "none" : "";
  if (offscreen) return;
  const leader = host.querySelector<SVGPathElement>("[data-part='leader']");
  const flag = host.querySelector<HTMLElement>("[data-part='flag-body']");
  if (!leader || !flag) return;
  const shift = (d: number) => (d > 0.38 ? 0 : d < -0.38 ? -1 : -0.5);
  // Flex children can overflow the wrapper's measured width. Clamp their full visual
  // extent, including the plate's tilt, rather than the wrapper's box alone.
  const box = flag.getBoundingClientRect();
  const childBoxes = [...flag.children].map((child) => child.getBoundingClientRect());
  const minX = Math.min(0, ...childBoxes.map((child) => child.left - box.left));
  const maxX = Math.max(flag.offsetWidth, ...childBoxes.map((child) => child.right - box.left));
  const minY = Math.min(0, ...childBoxes.map((child) => child.top - box.top));
  const maxY = Math.max(flag.offsetHeight, ...childBoxes.map((child) => child.bottom - box.top));
  const clamp = (value: number, coordinate: number, extent: number, min: number, max: number) =>
    Math.max(8 - coordinate - min, Math.min(value, extent - 8 - coordinate - max));
  const left = clamp(px * STOP_FLAG_LEADER_PX + shift(px) * (maxX - minX) - minX, origin.x, viewport.width, minX, maxX);
  const top = clamp(py * STOP_FLAG_LEADER_PX + shift(py) * (maxY - minY) - minY, origin.y, viewport.height, minY, maxY);
  flag.style.left = `${left.toFixed(2)}px`;
  flag.style.top = `${top.toFixed(2)}px`;
  flag.style.transform = "none";

  // Aim the dots at the placed shield, even when its body had to turn inward.
  const shield = host.querySelector<HTMLElement>("[data-part='shield']");
  if (!shield) return;
  const anchor = host.getBoundingClientRect();
  let target = shield.getBoundingClientRect();
  // A constrained horizontal placement can put the shield over its own door.
  // Move it above or below the dot before drawing the connection.
  if (target.left - 6 <= anchor.left && anchor.left <= target.right + 6 &&
      target.top - 6 <= anchor.top && anchor.top <= target.bottom + 6) {
    const topLimit = 8 - origin.y - minY;
    const bottomLimit = viewport.height - 8 - origin.y - maxY;
    const above = -8 - (target.bottom - anchor.top);
    const below = 8 - (target.top - anchor.top);
    const moves = py > 0 ? [below, above] : py < 0 ? [above, below] : origin.y < viewport.height / 2 ? [below, above] : [above, below];
    for (const move of moves) {
      const candidate = top + move;
      if (candidate >= topLimit && candidate <= bottomLimit) {
        flag.style.top = `${candidate.toFixed(2)}px`;
        target = shield.getBoundingClientRect();
        break;
      }
    }
  }
  const x0 = target.left - anchor.left;
  const x1 = target.right - anchor.left;
  const y0 = target.top - anchor.top;
  const y1 = target.bottom - anchor.top;
  const hits: number[] = [];
  if (px !== 0) for (const x of [x0, x1]) {
    const t = x / px;
    if (t > 0 && t * py >= y0 && t * py <= y1) hits.push(t);
  }
  if (py !== 0) for (const y of [y0, y1]) {
    const t = y / py;
    if (t > 0 && t * px >= x0 && t * px <= x1) hits.push(t);
  }
  const distance = Math.min(...hits);
  const end: [number, number] = Number.isFinite(distance)
    ? [px * distance, py * distance]
    : [Math.max(x0, Math.min(0, x1)), Math.max(y0, Math.min(0, y1))];
  const from = door ? 6 : 12;
  leader.setAttribute("d", `M${(px * from).toFixed(2)},${(py * from).toFixed(2)}L${end[0].toFixed(2)},${end[1].toFixed(2)}`);
}
