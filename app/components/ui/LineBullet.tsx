import type { HTMLAttributes } from "react";

export type LineColor = "blue" | "green" | "yellow";

export interface LineBulletProps extends HTMLAttributes<HTMLSpanElement> {
  line: LineColor;
  /** The line's letter or number — always shown, so color is never the only cue. */
  id: string;
  label?: string;
}

/** A transit line bullet: the identifier in a circle inside a pill of the line's color. */
export default function LineBullet({ line, id, label, className, ...rest }: LineBulletProps) {
  const classes = ["umbra-line-bullet", `umbra-line-bullet--${line}`, className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      <span className="sr-only">Line </span>
      <span className="umbra-line-bullet__id">{id}</span>
      {label && <span className="umbra-line-bullet__label">{label}</span>}
    </span>
  );
}
