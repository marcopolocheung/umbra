import type { SVGProps } from "react";

export type SigilName = "disc" | "sun" | "shade" | "tree" | "rain" | "transit" | "walk";
export const UMBRA_DISC_PATH = "M16 2a14 14 0 1 0 0 28 14 14 0 0 0 0-28Zm8-1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z";

interface SigilProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: SigilName;
  size?: number;
}

/** Umbra's original disc plus Tabler Icons v3.48.0 category drawings (MIT).
 * Source and license: docs/design/redesign-2.0/tabler-icons-license.md */
export default function Sigil({ name, size = 20, ...props }: SigilProps) {
  const base = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true as const, ...props };
  if (name === "disc") return (
    <svg {...base} viewBox="0 0 32 32">
      <title>Umbra disc</title>
      <path fill="currentColor" fillRule="evenodd" d={UMBRA_DISC_PATH} />
    </svg>
  );
  const stroke = { stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg {...base} {...stroke}>
      <title>{name}</title>
      {name === "sun" && <><path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" /></>}
      {name === "shade" && <><path d="M3 21l18 0" /><path d="M5 21v-14l8 -4v18" /><path d="M19 21v-10l-6 -4" /><path d="M9 9l0 .01M9 12l0 .01M9 15l0 .01M9 18l0 .01" /></>}
      {name === "tree" && <><path d="M12 13l-2 -2M12 12l2 -2M12 21v-13" /><path d="M9.824 16a3 3 0 0 1 -2.743 -3.69a3 3 0 0 1 .304 -4.833a3 3 0 0 1 4.615 -3.707a3 3 0 0 1 4.614 3.707a3 3 0 0 1 .305 4.833a3 3 0 0 1 -2.919 3.695h-4l-.176 -.005" /></>}
      {name === "rain" && <><path d="M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7" /><path d="M11 13v2m0 3v2m4 -5v2m0 3v2" /></>}
      {name === "transit" && <><path d="M21 13c0 -3.87 -3.37 -7 -10 -7h-8" /><path d="M3 15h16a2 2 0 0 0 2 -2M3 6v5h17.5M3 11v4M8 11v-5M13 11v-4.5M3 19h18" /></>}
      {name === "walk" && <><path d="M12 4a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M7 21l3 -4M16 21l-2 -4l-3 -3l1 -6M6 12l2 -3l4 -1l3 3l3 1" /></>}
    </svg>
  );
}
