import { describe, expect, it, vi } from "vitest";

const posts: unknown[] = [];
vi.mock("../../../workers/sunPosition.worker?worker", () => ({
  default: class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage(msg: unknown) {
      posts.push(msg);
    }
    terminate() {}
  },
}));

const { LocalShadowAdapter } = await import("../LocalShadowAdapter");

function adapterAt(center: { lat: number; lng: number }) {
  const layer = new LocalShadowAdapter();
  // Only the fields the sun request path reads: no WebGL, no onAdd.
  (layer as any).map = { getCenter: () => center, getCanvas: () => ({ width: 1, height: 1 }), triggerRepaint: () => {} };
  return layer;
}

function sunReply(layer: InstanceType<typeof LocalShadowAdapter>, altitudeDeg: number) {
  (layer as any).sunWorker.onmessage({
    data: { azimuthDeg: 20, altitudeDeg, azimuthRad: 20 * Math.PI / 180, altitudeRad: altitudeDeg * Math.PI / 180 },
  });
}

describe("sun worker requests", () => {
  it("posts one request per play tick, however many setters carry it", () => {
    posts.length = 0;
    const center = { lat: 40.754, lng: -73.984 };
    const layer = adapterAt(center);
    const t = new Date("2026-06-21T13:00:00Z");

    // One tick reaches the layer three ways: MapView's setDate, then page.tsx's
    // exposure effect calling setExposureContext and setHazard("sun").
    layer.setDate(t);
    layer.setHazard("sun");
    layer.setDate(new Date(t));
    expect(posts).toHaveLength(1);

    layer.setDate(new Date(t.getTime() + 120_000));
    expect(posts).toHaveLength(2);

    center.lat += 0.01;
    layer.setHazard("sun");
    expect(posts).toHaveLength(3);
    expect(posts[2]).toMatchObject({ lat: center.lat, timestamp: t.getTime() + 120_000 });
  });

  it("repaints at sunset and sunrise even across a sub-threshold angle change", () => {
    const center = { lat: 40.754, lng: -73.984 };
    const layer = adapterAt(center);
    const repaint = vi.fn();
    (layer as any).map.triggerRepaint = repaint;
    sunReply(layer, 0.04);
    sunReply(layer, -0.04);
    sunReply(layer, -0.08);
    sunReply(layer, 0.03);
    expect(repaint).toHaveBeenCalledTimes(3);
    expect((layer as any).lastSunAltDeg).toBe(0.03);
  });

  it("suppresses a cached day mesh before the sunset worker reply", () => {
    const layer = adapterAt({ lat: 40.754, lng: -73.984 });
    const repaint = vi.fn();
    (layer as any).map.triggerRepaint = repaint;
    (layer as any).lastSunAltRad = 0.001;
    (layer as any).program = {};
    (layer as any).positionBuffer = {};
    (layer as any).u_matrix = {};
    (layer as any).u_color = {};
    (layer as any).quadProgram = {};
    (layer as any).quadBuffer = {};
    (layer as any).cachedGeometry = { shadowVerts: new Float32Array([0, 0, 1, 0, 1, 1]) };
    (layer as any).dirty = false;
    layer.setDate(new Date("2026-06-22T02:00:00Z"));
    expect(repaint).toHaveBeenCalledTimes(1);
    layer.render({} as any, {} as any);
    expect((layer as any).dirty).toBe(true); // no stale geometry pass ran
  });

  it("keeps solar night empty while rain still extrudes and reads its mask", () => {
    const layer = adapterAt({ lat: 40.754, lng: -73.984 });
    const cache = {
      centerMerc: [0, 0],
      buildings: [{
        prism: { ring: [[-73.984, 40.754], [-73.9839, 40.754], [-73.9839, 40.7541], [-73.984, 40.7541]], heightM: 20 },
        normalizedH: 1,
        mercatorRoofVerts: new Float32Array([0, 0, 1, 0, 0, 1]),
      }],
    };
    const night = (layer as any).extrudeShadows(cache, { azimuthRad: 0, altitudeRad: -0.01, sunBelow: true });
    expect(night.sunBelowHorizon).toBe(true);
    expect(night.shadowVerts).toHaveLength(0);
    expect(night.roofVerts).toHaveLength(0);

    const gl = {
      FRAMEBUFFER_BINDING: 1, FRAMEBUFFER: 2, RGBA: 3, UNSIGNED_BYTE: 4,
      getParameter: vi.fn(() => null), bindFramebuffer: vi.fn(),
      readPixels: vi.fn((_x, _y, _w, _h, _format, _type, rgba: Uint8Array) => rgba.set([1, 17, 47, 178])),
    };
    (layer as any).gl = gl;
    (layer as any).fbo = {};
    (layer as any).fboWidth = 1;
    (layer as any).fboHeight = 1;
    layer.setDate(new Date("2026-06-22T02:00:00Z")); // Midtown solar night
    expect(layer.readBuildingShadowMask()).toBeNull();
    expect(gl.readPixels).not.toHaveBeenCalled();

    layer.setHazard("rain");
    const rainDirection = (layer as any).hazardDirection();
    expect(rainDirection.sunBelow).toBe(false);
    const rain = (layer as any).extrudeShadows(cache, rainDirection);
    expect(rain.sunBelowHorizon).toBe(false);
    expect(rain.shadowVerts.length).toBeGreaterThan(0);
    expect(layer.readBuildingShadowMask()?.data[0]).toBeGreaterThan(0);
  });

  it("does not re-extrude for the exposure context it already holds", async () => {
    const { resolveExposureContext } = await import("../../exposure");
    const layer = adapterAt({ lat: 40.754, lng: -73.984 });
    const at = (time: Date) => resolveExposureContext({ objective: "sun" }, { time, mapCenter: [-73.984, 40.754] });
    const t = new Date("2026-10-01T16:43:00Z");
    layer.setExposureContext(at(t));
    (layer as any).dirty = false;

    // A finished route re-sends the same context as a new object.
    layer.setExposureContext(at(new Date(t)));
    expect((layer as any).dirty).toBe(false);

    // setDate moved the clock alone: the same context must restore it.
    layer.setDate(new Date(t.getTime() + 3_600_000));
    (layer as any).dirty = false;
    layer.setExposureContext(at(new Date(t)));
    expect((layer as any).dirty).toBe(true);
    expect((layer as any).currentDate.getTime()).toBe(t.getTime());

    (layer as any).dirty = false;
    layer.setExposureContext(at(new Date(t.getTime() + 60_000)));
    expect((layer as any).dirty).toBe(true);
  });
});
