import type { HTMLAttributes } from "react";

/** A tone names a meaning; `sun` is only for actual sun, heat or exposure. */
export type TagTone = "neutral" | "sun" | "shade" | "canopy" | "rain" | "danger";

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: TagTone;
}

/** A short square badge: ink on the meaning's fill, hard offset shadow. */
export default function Tag({ tone = "neutral", className, ...rest }: TagProps) {
  const classes = ["umbra-tag", `umbra-tag--${tone}`, className].filter(Boolean).join(" ");
  return <span className={classes} {...rest} />;
}
