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
  (layer as any).map = { getCenter: () => center, triggerRepaint: () => {} };
  return layer;
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
});
