import type { SVGProps } from "react";

export type SigilName = "disc" | "sun" | "shade" | "tree" | "rain" | "transit" | "walk";
export const UMBRA_DISC_PATH = "M16 2a14 14 0 1 0 0 28 14 14 0 0 0 0-28Zm8-1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z";

interface SigilProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: SigilName;
  size?: number;
}

/** Umbra redesign 2.0's original civic pictograms. The disc's cutout is a
 * real hole, so the same mark works in ink, cream and map colours. */
export default function Sigil({ name, size = 20, ...props }: SigilProps) {
  const base = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true as const, ...props };
  if (name === "disc") return (
    <svg {...base} viewBox="0 0 32 32">
      <title>Umbra disc</title>
      <path fill="currentColor" fillRule="evenodd" d={UMBRA_DISC_PATH} />
    </svg>
  );
  const stroke = { stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg {...base} {...stroke}>
      <title>{name}</title>
      {name === "sun" && <><circle cx="12" cy="12" r="4.2" /><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1m10.6 10.6 2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1" /></>}
      {name === "shade" && <><path d="M4 18.5h16M6 15.5h12M7.5 12.5h9M8.5 9.5h7" /><path d="M18.7 5.4a7 7 0 1 0-9.3 10.1 8.2 8.2 0 0 1 9.3-10.1Z" /></>}
      {name === "tree" && <><path d="M12 21v-7m0 4-4-3m4 1 4-4M5 14l3-4-1-2 5-6 5 6-1 2 3 4-4 2H9l-4-2Z" /><path d="M8 21h8" /></>}
      {name === "rain" && <><path d="M5.2 15.3h12.7a3.1 3.1 0 0 0 .2-6.2 6.1 6.1 0 0 0-11.5-1.3 3.8 3.8 0 0 0-1.4 7.5Z" /><path d="m7 17.5-1 2.5m6-2.5-1 2.5m6-2.5-1 2.5" /></>}
      {name === "transit" && <><path d="M7 3h10l2 3v11l-2 2H7l-2-2V6l2-3Zm-2 9h14M8 19l-1 3m10-3 1 3" /><path d="M8 7h8M8 15h1m6 0h1" /></>}
      {name === "walk" && <><circle cx="14.5" cy="3.5" r="1.5" /><path d="m12 7-2 4 3 2 2 4m-3-10 4 3 3 1M10 11l-4 2m7 0-3 4-1 4m6-4 3 4" /></>}
    </svg>
  );
}
