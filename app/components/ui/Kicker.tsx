import type { HTMLAttributes } from "react";
import Plate from "./Plate";

export interface KickerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Sets the kicker on a tilted ink plate instead of bare on the surface. */
  plated?: boolean;
}

/** The brochure line above a title: stamped uppercase label, never a number. */
export default function Kicker({ plated = false, className, ...rest }: KickerProps) {
  const classes = ["umbra-kicker", className].filter(Boolean).join(" ");
  if (plated) return <Plate as="span" tone="ink" tilt className={classes} {...rest} />;
  return <span className={classes} {...rest} />;
}
