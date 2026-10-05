import { describe, expect, it, vi } from "vitest";
import { SHADOW_FBO_MAX_DIM, shadowTargetSize } from "../shadowTargetSize";

vi.mock("../../../workers/sunPosition.worker?worker", () => ({
  default: class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage() {}
    terminate() {}
  },
}));

const { LocalShadowAdapter } = await import("../LocalShadowAdapter");

describe("shadowTargetSize", () => {
  it("supersamples a settled canvas and renders 1× while moving", () => {
    expect(shadowTargetSize(1200, 800, false)).toEqual({ w: 2400, h: 1600 });
    expect(shadowTargetSize(1200, 800, true)).toEqual({ w: 1200, h: 800 });
  });

  it("caps each axis and never returns an empty target", () => {
    expect(shadowTargetSize(3000, 1000, false)).toEqual({ w: SHADOW_FBO_MAX_DIM, h: 2000 });
    expect(shadowTargetSize(0, 0, true)).toEqual({ w: 1, h: 1 });
  });
});

/** Just enough WebGL2 for `ensureFBO` and `readBuildingShadowMask`. */
function stubGl() {
  let id = 0;
  return {
    FRAMEBUFFER_BINDING: 1, FRAMEBUFFER: 2, RGBA: 3, UNSIGNED_BYTE: 4, TEXTURE_BINDING_2D: 5,
    FRAMEBUFFER_COMPLETE: 6, TEXTURE_2D: 7,
    getParameter: vi.fn(() => null),
    bindFramebuffer: vi.fn(),
    bindTexture: vi.fn(),
    createFramebuffer: vi.fn(() => ({ fb: ++id })),
    createTexture: vi.fn(() => ({ tex: ++id })),
    deleteFramebuffer: vi.fn(),
    deleteTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    framebufferTexture2D: vi.fn(),
    drawBuffers: vi.fn(),
    readBuffer: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 6),
    readPixels: vi.fn(),
  };
}

function adapter(map: Record<string, unknown> = {}) {
  const layer = new LocalShadowAdapter();
  const gl = stubGl();
  const canvas = { width: 300, height: 200, clientWidth: 300, clientHeight: 200 };
  (layer as any).gl = gl;
  (layer as any).map = {
    getCenter: () => ({ lat: 40.754, lng: -73.984 }),
    getCanvas: () => canvas,
    isMoving: () => false,
    redraw: vi.fn(),
    triggerRepaint: () => {},
    ...map,
  };
  layer.setHazard("rain"); // rain reads its mask at any hour
  const ensure = (moving: boolean, w = 300, h = 200) => {
    const size = shadowTargetSize(w, h, moving);
    (layer as any).ensureFBO(gl, moving ? "lo" : "hi", size.w, size.h);
  };
  return { layer, gl, ensure, map: (layer as any).map };
}

describe("shadow target sets", () => {
  it("keeps both sets alive across gestures instead of reallocating", () => {
    const { gl, ensure } = adapter();
    for (const moving of [false, true, false, true, false]) ensure(moving);
    // One shadow + one height texture per set, two sets, allocated once each.
    expect(gl.createTexture).toHaveBeenCalledTimes(4);
    expect(gl.deleteTexture).not.toHaveBeenCalled();
  });

  it("a resize reallocates only the set in use", () => {
    const { gl, ensure } = adapter();
    ensure(false);
    ensure(true);
    ensure(false, 400, 300);
    expect(gl.createTexture).toHaveBeenCalledTimes(6);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
  });

  it("reads the mask at the size of the set in use", () => {
    const { layer, gl, ensure } = adapter({ isMoving: () => true });
    ensure(true);
    const moving = layer.readBuildingShadowMask();
    expect(gl.readPixels).toHaveBeenLastCalledWith(0, 0, 300, 200, gl.RGBA, gl.UNSIGNED_BYTE, expect.any(Uint8Array));
    expect(moving).toMatchObject({ width: 300, height: 200, pixelRatioX: 1, pixelRatioY: 1 });
    ensure(false);
    expect(layer.readBuildingShadowMask()).toMatchObject({ width: 600, height: 400, pixelRatioX: 2 });
  });

  it("renders the settled frame before reading a mask left on the 1× set", () => {
    const { layer, ensure, map } = adapter();
    ensure(true); // last paint happened mid-gesture; the map has since stopped
    layer.readBuildingShadowMask();
    expect(map.redraw).toHaveBeenCalledTimes(1);
    ensure(false);
    layer.readBuildingShadowMask();
    expect(map.redraw).toHaveBeenCalledTimes(1);
  });
});
