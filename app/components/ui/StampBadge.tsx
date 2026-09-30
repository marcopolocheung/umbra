import type { HTMLAttributes } from "react";
import { STAMP } from "./motion";

export interface StampBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "ink" | "sun" | "shade";
}

/**
 * A round rubber stamp in one ink, set slightly askew, that lands with the
 * stamp motion. Words only (ARRIVED, SHADED): numbers are never tilted. Only
 * the inked ring rotates; the element's own box stays square.
 */
export default function StampBadge({ tone = "ink", className, children, ...rest }: StampBadgeProps) {
  const classes = ["umbra-stamp-badge", tone !== "ink" && `umbra-stamp-badge--${tone}`, className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      <span className={`umbra-stamp-badge__ink ${STAMP}`}>{children}</span>
    </span>
  );
}
