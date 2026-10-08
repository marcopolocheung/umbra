/**
 * A new sun is a uniform, not a mesh.
 *
 * The ground-shadow mesh is uploaded once per building cache; a time change only
 * re-places it in the vertex shader. These tests drive `render()` against a WebGL
 * stub that records every call, and pin that contract: one upload per cache, none
 * per sun, the same vertex count drawn, and the shift uniform following the sun.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../workers/sunPosition.worker?worker", () => ({
  default: class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage() {}
    terminate() {}
  },
}));

const { LocalShadowAdapter } = await import("../LocalShadowAdapter");

const LAT = 40.754;
const LNG = -73.984;

/** A WebGL2 stand-in: every method is a recorded no-op, every constant a number. */
function recordingGl() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let id = 0;
  const gl: any = new Proxy(
    { canvas: { width: 300, height: 200 } },
    {
      get(target: any, prop: string) {
        if (prop in target) return target[prop];
        // Constants keep one value each, so `getParameter(gl.VIEWPORT)` can be recognised.
        if (/^[A-Z0-9_]+$/.test(prop)) {
          target[prop] = ++id;
          return target[prop];
        }
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          if (prop === "checkFramebufferStatus") return gl.FRAMEBUFFER_COMPLETE;
          if (prop.startsWith("create")) return { handle: ++id };
          // The composite restores the viewport it read; everything else may be null.
          if (prop === "getParameter") return args[0] === gl.VIEWPORT ? [0, 0, 300, 200] : null;
          return undefined;
        };
      },
    },
  );
  return { gl, calls };
}

function square(dLng: number): [number, number][] {
  const s = 0.0002;
  return [
    [LNG + dLng, LAT], [LNG + dLng + s, LAT], [LNG + dLng + s, LAT + s], [LNG + dLng, LAT + s], [LNG + dLng, LAT],
  ];
}

function adapterWithBuildings() {
  const { gl, calls } = recordingGl();
  const layer = new LocalShadowAdapter({ date: new Date("2026-06-21T16:00:00Z") });
  const features = [0, 0.0005].map((dLng) => ({
    properties: { render_height: 40 },
    geometry: { type: "Polygon", coordinates: [square(dLng)] },
  }));
  const map = {
    getCenter: () => ({ lat: LAT, lng: LNG }),
    getBounds: () => ({ getWest: () => LNG - 0.01, getSouth: () => LAT - 0.01, getEast: () => LNG + 0.01, getNorth: () => LAT + 0.01 }),
    getZoom: () => 17,
    getPitch: () => 0,
    isMoving: () => false,
    isSourceLoaded: () => true,
    querySourceFeatures: () => features,
    triggerRepaint: () => {},
    getCanvas: () => ({ width: 300, height: 200, clientWidth: 300, clientHeight: 200 }),
    painter: { context: { depthRange: { get: () => [0, 1] } } },
  };
  (layer as any).map = map;
  (layer as any).gl = gl;
  // The programs and buffers onAdd would have made; their handles only need to be truthy.
  for (const name of [
    "program", "positionBuffer", "shadowShiftBuffer", "u_matrix", "u_color", "quadProgram", "quadBuffer",
    "heightProgram", "shadowHeightBuffer", "roofProgram", "roofPosBuffer", "roofHeightBuffer",
  ]) {
    (layer as any)[name] = { handle: name };
  }
  // A settled sun high in the sky, as the worker would have reported it.
  (layer as any).lastSunAzRad = 0.4;
  (layer as any).lastSunAltRad = 0.9;
  (layer as any).lastSunAzDeg = 0.4 * 180 / Math.PI;
  (layer as any).lastSunAltDeg = 0.9 * 180 / Math.PI;
  return { layer, calls };
}

const frame = { defaultProjectionData: { mainMatrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } } as any;

function count(calls: Array<{ name: string }>, name: string) {
  return calls.filter((c) => c.name === name).length;
}

describe("GPU-placed ground shadows", () => {
  it("uploads the mesh once per cache and only re-places it for a new sun", () => {
    const { layer, calls } = adapterWithBuildings();
    const gl = (layer as any).gl;

    layer.render(gl, frame);
    const cache = (layer as any).buildingCache;
    expect(cache.shadowVertexCount).toBeGreaterThan(0);
    // Five static buffers: base, shift, ceiling, roof positions, roof heights.
    expect(count(calls, "bufferData")).toBe(5);
    const draws = calls.filter((c) => c.name === "drawArrays").map((c) => c.args[2]);
    expect(draws).toContain(cache.shadowVertexCount);
    const firstShift = calls.filter((c) => c.name === "uniform2f").map((c) => c.args.slice(1));

    // A new sun: the worker reply marks the frame dirty; nothing is rebuilt or re-sent.
    calls.length = 0;
    (layer as any).sunWorker.onmessage({
      data: { azimuthDeg: 40, altitudeDeg: 30, azimuthRad: 40 * Math.PI / 180, altitudeRad: 30 * Math.PI / 180 },
    });
    layer.render(gl, frame);
    expect(count(calls, "bufferData")).toBe(0);
    expect((layer as any).buildingCache).toBe(cache);
    const nextShift = calls.filter((c) => c.name === "uniform2f").map((c) => c.args.slice(1));
    expect(nextShift).not.toEqual(firstShift);
    expect(calls.filter((c) => c.name === "drawArrays").map((c) => c.args[2])).toContain(cache.shadowVertexCount);

    // A new cache uploads again, once.
    calls.length = 0;
    (layer as any).buildingCache = null;
    (layer as any).dirty = true;
    layer.render(gl, frame);
    expect(count(calls, "bufferData")).toBe(5);
  });

  it("draws no ground shadow at solar night", () => {
    const { layer, calls } = adapterWithBuildings();
    layer.render((layer as any).gl, frame);
    calls.length = 0;
    // Solar night in Midtown; render() returns before any pass.
    layer.setDate(new Date("2026-06-22T04:00:00Z"));
    layer.render((layer as any).gl, frame);
    expect(count(calls, "drawArrays")).toBe(0);
  });
});
