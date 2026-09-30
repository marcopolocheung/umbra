import { createElement, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type HTMLAttributes } from "react";

export type PlateTone = "panel" | "shade" | "ink";

interface PlateLook {
  tone?: PlateTone;
  /** Tilts the painted plate only; the content and hit area stay square. */
  tilt?: boolean;
}

/**
 * `button` and `a` make the plate itself the control, so its inner focus
 * stroke draws on focus — a plate wrapped in a button never gets focus.
 */
export type PlateProps = PlateLook &
  (
    | ({ as?: "div" | "span" | "section" | "article" | "li" } & HTMLAttributes<HTMLElement>)
    | ({ as: "button" } & ButtonHTMLAttributes<HTMLButtonElement>)
    | ({ as: "a" } & AnchorHTMLAttributes<HTMLAnchorElement>)
  );

/**
 * A printed plate: an irregular quadrilateral with a zero-blur offset shadow.
 * The quad is a background layer; the element itself stays rectangular, so
 * focus strokes and hit areas are never clipped. Decorative surfaces only —
 * never the map canvas.
 */
export default function Plate({ as = "div", tone = "panel", tilt = false, className, children, ...rest }: PlateProps) {
  const classes = ["umbra-plate", `umbra-plate--${tone}`, tilt && "umbra-plate--tilt", className].filter(Boolean).join(" ");
  return createElement(
    as,
    // A button that forgets its type would submit an enclosing form.
    { ...(as === "button" ? { type: "button" } : {}), ...rest, className: classes },
    children,
    // Last, so `space-y`/`divide-y` and `:first-child` on the content ignore it.
    <span className="umbra-plate__ground" aria-hidden="true" />,
  );
}
