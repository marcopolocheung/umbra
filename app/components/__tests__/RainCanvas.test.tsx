/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RainCanvas, { downwindDrift, rainCapacity, rainSlope, stepRain, type RainState } from "../RainCanvas";

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
    const view = render(<RainCanvas scrollRef={scrollRef} rainMode windFromDeg={270} windSpeedMs={4} />);
    expect(screen.getByTestId("directions-rain-canvas")).toBeTruthy();
    expect(request).toHaveBeenCalled();
    // On Sun the shower drains before the canvas goes; unmounting cancels the frame.
    view.rerender(<RainCanvas scrollRef={scrollRef} rainMode={false} windFromDeg={270} windSpeedMs={4} />);
    expect(screen.getByTestId("directions-rain-canvas")).toBeTruthy();
    view.unmount();
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
    render(<RainCanvas scrollRef={{ current: scroll }} rainMode windFromDeg={270} windSpeedMs={4} />);
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
    render(<RainCanvas scrollRef={scrollRef} rainMode windFromDeg={270} windSpeedMs={4} />);
    expect(screen.queryByTestId("directions-rain-canvas")).toBeNull();
  });

  it("splashes a drop on a control's top edge instead of letting it through", () => {
    const state: RainState = { drops: [{ x: 100, y: 95, vx: 0, vy: .6 }], particles: [], beads: [] };
    const random = () => .5;
    stepRain(state, 16, [{ left: 50, right: 150, top: 100 }], { width: 390, height: 400, capacity: 1, slope: 0, random });
    expect(state.particles.length).toBeGreaterThanOrEqual(3);
    expect(state.particles.every((p) => p.y < 100 && p.vy < 0)).toBe(true);
    expect(state.drops[0].y).toBeLessThan(0);
  });

  it("slides a bead along the edge and drips it off the end, never into the control", () => {
    const state: RainState = { drops: [], particles: [], beads: [{ x: 148, y: 100, left: 50, right: 150, v: .2, life: 900 }] };
    stepRain(state, 16, [], { width: 390, height: 400, capacity: 0, slope: 0, random: () => .5 });
    expect(state.beads).toHaveLength(0);
    expect(state.particles).toHaveLength(1);
    expect(state.particles[0].x).toBeGreaterThan(150);
  });

  it("leans falling drops toward a new wind without restarting them", () => {
    const state: RainState = { drops: [{ x: 100, y: 10, vx: 0, vy: .6 }], particles: [], beads: [] };
    const slope = rainSlope(270, 9);
    for (let i = 0; i < 60; i++) stepRain(state, 16, [], { width: 390, height: 4000, capacity: 1, slope, random: () => .5 });
    expect(state.drops[0].vx).toBeGreaterThan(0);
    expect(state.drops[0].vx / state.drops[0].vy).toBeCloseTo(slope, 1);
    expect(state.drops[0].y).toBeGreaterThan(10);
  });
});
