import type { CSSProperties, HTMLAttributes } from "react";
import { lineBulletInk, lineCssColor } from "../../lib/lineBulletInk";

export type LineColor = "blue" | "green" | "yellow";

export interface LineBulletProps extends HTMLAttributes<HTMLSpanElement> {
  line?: LineColor;
  /** The line's own published colour; replaces `line`, so the card matches the map. */
  accent?: string;
  /** The line's letter or number — always shown, so color is never the only cue. */
  code: string;
  label?: string;
}

/** A transit line bullet: the identifier in a circle inside a pill of the line's color. */
export default function LineBullet({ line = "blue", accent, code, label, className, style, ...rest }: LineBulletProps) {
  const color = accent ? lineCssColor(accent) : undefined;
  const ink = color ? lineBulletInk(color) : null;
  const classes = [
    "umbra-line-bullet",
    color ? "umbra-line-bullet--data" : `umbra-line-bullet--${line}`,
    color && !ink && "umbra-line-bullet--ringed",
    className,
  ].filter(Boolean).join(" ");
  const accentStyle = color
    ? ({ "--line-accent": color, "--line-on": `var(--color-line-ink-${ink ?? "dark"})` } as CSSProperties)
    : undefined;
  return (
    <span className={classes} style={accentStyle ? { ...accentStyle, ...style } : style} {...rest}>
      <span className="sr-only">Line </span>
      <span className="umbra-line-bullet__id">{code}</span>
      {/* The space separates the words for screen readers; flex layout drops it. */}
      {label && <> <span className="umbra-line-bullet__label">{label}</span></>}
    </span>
  );
}
