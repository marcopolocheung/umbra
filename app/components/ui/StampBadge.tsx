import type { HTMLAttributes } from "react";
import { STAMP } from "./motion";

export interface StampBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "ink" | "sun" | "shade";
}

/**
 * A round rubber stamp in one ink, set slightly askew, that lands with the
 * stamp motion. Words only (ARRIVED, SHADED): numbers are never tilted.
 * Not interactive — never wrap a control in it.
 */
export default function StampBadge({ tone = "ink", className, ...rest }: StampBadgeProps) {
  const classes = ["umbra-stamp-badge", tone !== "ink" && `umbra-stamp-badge--${tone}`, STAMP, className]
    .filter(Boolean)
    .join(" ");
  return <span className={classes} {...rest} />;
}
