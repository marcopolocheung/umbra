// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import registryCss from "../../../globals.css?raw";
import GrainSurface from "../GrainSurface";
import Kicker from "../Kicker";
import LineBullet from "../LineBullet";
import { INK_REVEAL, STAMP } from "../motion";
import Plate from "../Plate";
import StampBadge from "../StampBadge";
import Tag from "../Tag";

afterEach(cleanup);

interface Rule {
  selector: string;
  body: string;
  /** Enclosing at-rule preludes, outermost first. */
  within: string[];
}

/** Innermost style rules of the registry, with the at-rules that enclose them. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      // Nested style rules would fold a parent's declarations into a child selector.
      if (stack.length && !stack[stack.length - 1].startsWith("@")) throw new Error("nested CSS rule in the registry");
      stack.push(text.slice(start, i).trim());
      start = i + 1;
    } else if (text[i] === "}") {
      const selector = stack.pop() ?? "";
      const body = text.slice(start, i);
      if (!selector.startsWith("@") && !body.includes("{")) out.push({ selector, body, within: stack.filter((s) => s.startsWith("@")) });
      start = i + 1;
    } else if (text[i] === ";" && stack.length === 0) {
      start = i + 1;
    }
  }
  return out;
}

const REGISTRY = rules(registryCss);
const SMALL_HOSTS = ["umbra-kicker", "umbra-tag", "umbra-line-bullet", "umbra-stamp-badge", "umbra-grain"];
const PRIMITIVE = /\.umbra-(plate|kicker|tag|line-bullet|stamp-badge|grain)/;

describe("primitive registry rules", () => {
  it.each(SMALL_HOSTS)("rings a focused .%s in page ink outside its square box", (cls) => {
    const focus = REGISTRY.find((r) => r.selector.includes(`.${cls}`) && r.selector.includes(":focus-visible"));
    expect(focus?.body).toMatch(/outline:\s*2px solid var\(--color-ink\)/);
    expect(focus?.body).toMatch(/outline-offset:\s*2px/);
  });

  it("strokes a focused plate in full ink between two nested clipped quads", () => {
    const focus = REGISTRY.find((r) => r.selector === ".umbra-plate:focus-visible");
    expect(focus?.body).toMatch(/--plate-stroke:\s*currentColor/);
    const both = REGISTRY.find((r) => r.selector.includes(".umbra-plate__ground::before") && r.selector.includes(".umbra-plate__ground::after"));
    expect(both?.body).toMatch(/clip-path:\s*var\(--plate-clip\)/);
    expect(REGISTRY.find((r) => r.selector === ".umbra-plate__ground::before")?.body).toMatch(/background:\s*var\(--plate-stroke\)/);
    expect(REGISTRY.find((r) => r.selector === ".umbra-plate__ground::after")?.body).toMatch(/inset:\s*[1-9]px;\s*background:\s*var\(--plate-fill\)/);
  });

  it("rotates only inner layers, never a host box", () => {
    const rotated = REGISTRY.filter((r) => PRIMITIVE.test(r.selector) && /(^|[\s;])(rotate:|transform:[^;]*rotate)/.test(r.body)).map(
      (r) => r.selector,
    );
    expect(rotated.sort()).toEqual([".umbra-plate--tilt > .umbra-plate__ground", ".umbra-stamp-badge__ink"]);
  });

  it("hands a coloured plate's ink to bare labels and stamps set on it", () => {
    const inherit = REGISTRY.find((r) => r.selector.startsWith(":is(.umbra-plate--shade, .umbra-plate--ink)"));
    expect(inherit?.selector).toContain(".umbra-kicker");
    expect(inherit?.selector).toContain(".umbra-stamp-badge__ink");
    expect(inherit?.body).toMatch(/color:\s*inherit/);
  });

  it("clips the plate's ground layer, not the element that carries content and focus", () => {
    const clipped = REGISTRY.filter((r) => r.body.includes("clip-path: var(--plate-clip)")).map((r) => r.selector);
    expect(clipped).toEqual([".umbra-plate__ground::before,\n  .umbra-plate__ground::after"]);
  });

  it("animates stamp and ink reveal only when motion is welcome", () => {
    for (const cls of [STAMP, INK_REVEAL]) {
      const animated = REGISTRY.filter((r) => r.selector === `.${cls}`);
      expect(animated).toHaveLength(1);
      // Backwards fill leaves no mask on the element after completion.
      expect(animated[0].body).toMatch(/animation:[^;]*\bbackwards;/);
      expect(animated[0].within).toEqual(["@media (prefers-reduced-motion: no-preference)"]);
    }
  });

  it("reveals through the original speckled SVG mask, then removes the mask", () => {
    const svg = readFileSync(resolve(process.cwd(), "public/ink-reveal-mask.svg"), "utf8");
    expect(svg).toContain('width="82"');
    expect(svg).toContain('<path d="M82');
    expect(svg.match(/<circle /g)?.length).toBeGreaterThan(10);
    const frames = REGISTRY.filter((r) => r.within.includes("@keyframes umbra-ink-reveal"));
    expect(frames.map((r) => r.selector)).toEqual(["from", "to"]);
    expect(frames[0].body).toMatch(/mask-image:\s*url\("\/ink-reveal-mask.svg"\)/);
    expect(frames[0].body).toMatch(/mask-size:\s*0% 100%/);
    expect(frames[1].body).toMatch(/mask-size:\s*130% 100%/);
    expect(frames.every((r) => !r.body.includes("clip-path") && !r.body.includes("opacity"))).toBe(true);
    expect(REGISTRY.filter((r) => r.selector === `.${INK_REVEAL}` && r.body.includes("mask-image"))).toHaveLength(0);
  });

  it("drops the grain under reduced transparency and keeps it beneath content", () => {
    const grain = REGISTRY.filter((r) => r.selector === ".umbra-grain::before");
    expect(grain.find((r) => r.within[0] === "@layer components")?.body).toMatch(/z-index:\s*-1/);
    expect(grain.find((r) => r.within[0]?.includes("(prefers-reduced-transparency: reduce)"))?.body).toMatch(/display:\s*none/);
  });
});

describe("Plate", () => {
  it("paints an aria-hidden ground after the content on a square host", () => {
    render(
      <Plate as="section" tone="shade" tilt aria-label="Shade walk">
        <p>18 min</p>
      </Plate>,
    );
    const plate = screen.getByRole("region", { name: "Shade walk" });
    expect(plate.className).toBe("umbra-plate umbra-plate--shade umbra-plate--tilt");
    const ground = plate.lastElementChild as HTMLElement;
    expect(ground.className).toBe("umbra-plate__ground");
    expect(ground.getAttribute("aria-hidden")).toBe("true");
    expect(ground.textContent).toBe("");
    expect(screen.getByText("18 min")).toBe(plate.firstElementChild);
  });

  it("is a flat panel by default and passes focusability through", () => {
    render(<Plate tabIndex={0}>Stop</Plate>);
    const plate = screen.getByText("Stop");
    expect(plate.tagName).toBe("DIV");
    expect(plate.className).toBe("umbra-plate umbra-plate--panel");
    plate.focus();
    expect(document.activeElement).toBe(plate);
  });

  it("is itself the control as a button, so its own focus stroke draws", () => {
    let pressed = 0;
    render(
      <Plate as="button" tone="ink" onClick={() => pressed++}>
        Start
      </Plate>,
    );
    const plate = screen.getByRole("button", { name: "Start" });
    expect(plate.className).toBe("umbra-plate umbra-plate--ink");
    // Never a stray form submit.
    expect(plate.getAttribute("type")).toBe("button");
    plate.focus();
    expect(document.activeElement).toBe(plate);
    plate.click();
    expect(pressed).toBe(1);
  });

  it("is a link with its href as an anchor", () => {
    render(<Plate as="a" href="#stops">Stops</Plate>);
    const link = screen.getByRole("link", { name: "Stops" });
    expect(link.getAttribute("href")).toBe("#stops");
    expect(link.lastElementChild?.className).toBe("umbra-plate__ground");
  });
});

describe("Kicker", () => {
  it("renders a bare stamped label", () => {
    render(<Kicker className="mb-1">Keep cool on</Kicker>);
    const kicker = screen.getByText("Keep cool on");
    expect(kicker.tagName).toBe("SPAN");
    expect(kicker.className).toBe("umbra-kicker mb-1");
  });

  it("sets a plated kicker on a tilted ink plate", () => {
    render(<Kicker plated>Shade walk</Kicker>);
    const kicker = screen.getByText("Shade walk");
    expect(kicker.tagName).toBe("SPAN");
    expect(kicker.className).toBe("umbra-plate umbra-plate--ink umbra-plate--tilt umbra-kicker");
    expect(kicker.querySelector(".umbra-plate__ground")).not.toBeNull();
  });
});

describe("Tag", () => {
  it("defaults to neutral ink and takes a meaning tone", () => {
    render(
      <>
        <Tag>Open</Tag>
        <Tag tone="rain">Covered</Tag>
      </>,
    );
    expect(screen.getByText("Open").className).toBe("umbra-tag umbra-tag--neutral");
    expect(screen.getByText("Covered").className).toBe("umbra-tag umbra-tag--rain");
  });
});

describe("LineBullet", () => {
  it("always shows the identifier and reads as a line to assistive tech", () => {
    render(<LineBullet line="yellow" code="Q" label="Uptown" id="q-line" />);
    const bullet = document.getElementById("q-line") as HTMLElement;
    expect(bullet.className).toBe("umbra-line-bullet umbra-line-bullet--yellow");
    expect(bullet.textContent).toBe("Line Q Uptown");
    expect(screen.getByText("Q").className).toBe("umbra-line-bullet__id");
  });

  it("fills with a line's published colour and inks the identifier to read on it", () => {
    render(<LineBullet accent="#ffe14d" code="Q" data-testid="q" />);
    const bullet = screen.getByTestId("q");
    expect(bullet.className).toBe("umbra-line-bullet umbra-line-bullet--data");
    expect(bullet.style.getPropertyValue("--line-accent")).toBe("#ffe14d");
    expect(bullet.style.getPropertyValue("--line-on")).toBe("var(--color-line-ink-dark)");
  });

  it("rings the identifier when no ink reads on the line's colour", () => {
    render(<LineBullet accent="#4d75c3" code="7" data-testid="seven" />);
    expect(screen.getByTestId("seven").className).toBe("umbra-line-bullet umbra-line-bullet--data umbra-line-bullet--ringed");
    expect(screen.getByText("7").className).toBe("umbra-line-bullet__id");
  });

  it("omits the label slot when there is no label", () => {
    render(<LineBullet line="green" code="4" data-testid="bullet" />);
    expect(screen.getByTestId("bullet").querySelector(".umbra-line-bullet__label")).toBeNull();
  });
});

describe("StampBadge", () => {
  it("stamps in an inked ring inside a square host", () => {
    render(<StampBadge tone="sun">Arrived</StampBadge>);
    const ink = screen.getByText("Arrived");
    expect(ink.className).toBe(`umbra-stamp-badge__ink ${STAMP}`);
    expect(ink.parentElement?.className).toBe("umbra-stamp-badge umbra-stamp-badge--sun");
  });

  it("uses plain ink by default", () => {
    render(<StampBadge>Shaded</StampBadge>);
    expect(screen.getByText("Shaded").parentElement?.className).toBe("umbra-stamp-badge");
  });
});

describe("GrainSurface", () => {
  it("wraps content in a grained paper surface", () => {
    render(
      <GrainSurface className="bg-panel" data-testid="paper">
        <p>Postcard</p>
      </GrainSurface>,
    );
    const paper = screen.getByTestId("paper");
    expect(paper.className).toBe("umbra-grain bg-panel");
    expect(screen.getByText("Postcard").parentElement).toBe(paper);
  });
});
