import type { HTMLAttributes } from "react";

/**
 * A paper surface with print grain beneath its content. Give it a solid
 * background; never place it over the map canvas. Reduced transparency
 * removes the grain.
 */
export default function GrainSurface({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={["umbra-grain", className].filter(Boolean).join(" ")} {...rest} />;
}
