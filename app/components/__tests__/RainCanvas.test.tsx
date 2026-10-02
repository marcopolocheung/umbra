/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RainCanvas, { downwindDrift, rainCapacity } from "../RainCanvas";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Directions rain canvas", () => {
  it("uses the forecast wind-from bearing for downwind drift and caps low-end work", () => {
    expect(downwindDrift(270, 4)).toBeGreaterThan(0);
    expect(downwindDrift(90, 4)).toBeLessThan(0);
    expect(downwindDrift(null, 4)).toBe(0);
    expect(rainCapacity(true, true)).toBe(75);
    expect(rainCapacity(true, false)).toBe(24);
  });

  it("cancels its animation frame when Rain turns off", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(), clearRect: vi.fn(),
    } as never);
    const scroll = document.createElement("div");
    Object.defineProperties(scroll, { clientWidth: { value: 390 }, clientHeight: { value: 400 } });
    const scrollRef = { current: scroll };
    const view = render(<RainCanvas scrollRef={scrollRef} rainMode windFromDeg={270} windSpeedMs={4} height={400} />);
    expect(screen.getByTestId("directions-rain-canvas")).toBeTruthy();
    expect(request).toHaveBeenCalled();
    view.rerender(<RainCanvas scrollRef={scrollRef} rainMode={false} windFromDeg={270} windSpeedMs={4} height={400} />);
    expect(screen.queryByTestId("directions-rain-canvas")).toBeNull();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("pauses while the document is hidden and resumes when visible", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(), clearRect: vi.fn(),
    } as never);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const scroll = document.createElement("div");
    Object.defineProperties(scroll, { clientWidth: { value: 390 }, clientHeight: { value: 400 } });
    render(<RainCanvas scrollRef={{ current: scroll }} rainMode windFromDeg={270} windSpeedMs={4} height={400} />);
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cancel).toHaveBeenCalledWith(7);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("renders no canvas under reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const scrollRef = { current: document.createElement("div") };
    render(<RainCanvas scrollRef={scrollRef} rainMode windFromDeg={270} windSpeedMs={4} height={400} />);
    expect(screen.queryByTestId("directions-rain-canvas")).toBeNull();
  });
});
