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
