import { createElement, type HTMLAttributes } from "react";

export type PlateTone = "panel" | "shade" | "ink";

export interface PlateProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "span" | "section" | "article" | "li";
  tone?: PlateTone;
  /** Tilts the painted plate only; the content and hit area stay square. */
  tilt?: boolean;
}

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
    { ...rest, className: classes },
    <span className="umbra-plate__ground" aria-hidden="true" />,
    children,
  );
}
