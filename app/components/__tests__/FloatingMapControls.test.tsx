/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type maplibregl from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tilt3DButton } from "../FloatingMapControls";

/**
 * There is no `setupFiles` in vitest.config.ts, so unmounting is this file's job.
 */
afterEach(cleanup);

/** Minimal stand-in for the map — the component only ever reaches through `mapRef`. */
function fakeMap(pitch: number) {
  return {
    getPitch: vi.fn(() => pitch),
    easeTo: vi.fn(),
    jumpTo: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  };
}

function setPrefersReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function renderControls(map: ReturnType<typeof fakeMap> | null, pitch: number) {
  const mapRef = { current: map as unknown as maplibregl.Map | null };
  render(<Tilt3DButton mapRef={mapRef} pitch={pitch} />);
  return mapRef;
}

describe("FloatingMapControls — 2D/3D toggle", () => {
  it("tilts to 3D when the camera is flat", () => {
    setPrefersReducedMotion(false);
    const map = fakeMap(0);
    renderControls(map, 0);

    fireEvent.click(screen.getByLabelText("Tilt to 3D map"));

    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ pitch: 55 }));
    expect(map.jumpTo).not.toHaveBeenCalled();
  });

  it("returns to 2D when the camera is already tilted", () => {
    setPrefersReducedMotion(false);
    const map = fakeMap(55);
    renderControls(map, 55);

    fireEvent.click(screen.getByLabelText("Return to 2D map"));

    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ pitch: 0 }));
  });

  it("reflects the current mode to assistive tech", () => {
    setPrefersReducedMotion(false);
    renderControls(fakeMap(55), 55);

    // Plain DOM assertion: @testing-library/jest-dom is not a dependency and there is
    // no setupFiles to register its matchers.
    expect(screen.getByLabelText("Return to 2D map").getAttribute("aria-pressed")).toBe("true");
  });

  it("jumps instead of easing under prefers-reduced-motion", () => {
    setPrefersReducedMotion(true);
    const map = fakeMap(0);
    renderControls(map, 0);

    fireEvent.click(screen.getByLabelText("Tilt to 3D map"));

    expect(map.jumpTo).toHaveBeenCalledWith({ pitch: 55 });
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("does not throw before the map has loaded", () => {
    setPrefersReducedMotion(false);
    renderControls(null, 0);

    expect(() => fireEvent.click(screen.getByLabelText("Tilt to 3D map"))).not.toThrow();
  });
});
