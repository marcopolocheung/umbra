import { describe, expect, it } from "vitest";
import worker, { navigationRequestedKey, requestedKey } from "./index";

const generation = "nyc-2026-09-18-9f2924750af1";

function navigationKey(path: string): string | undefined {
  return navigationRequestedKey(new URL(`https://data.example.com${path}`));
}

/** Minimal R2 stub: the handler only calls `head`/`get` on the right bucket. */
function bucketWith(objects: Record<string, { body: string; etag: string }>) {
  return {
    calls: [] as string[],
    async head(objectKey: string) {
      this.calls.push(`head:${objectKey}`);
      const object = objects[objectKey];
      return object ? { httpEtag: object.etag } : null;
    },
    async get(objectKey: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
      this.calls.push(`get:${objectKey}`);
      const object = objects[objectKey];
      if (!object) return null;
      const all = new TextEncoder().encode(object.body);
      const stream = (bytes: Uint8Array) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      const range = options?.range;
      if (range) {
        const length = range.suffix ?? range.length ?? all.length;
        const offset = range.suffix !== undefined ? all.length - length : (range.offset ?? 0);
        const slice = all.slice(offset, offset + length);
        return { httpEtag: object.etag, size: all.length, range: { offset, length: slice.length }, body: stream(slice) };
      }
      return { httpEtag: object.etag, size: all.length, body: stream(all) };
    },
  };
}

function envWith(objects: Record<string, { body: string; etag: string }>) {
  const navigation = bucketWith({
    "navigation/nyc/current.json": { body: '{"version":1}', etag: '"pointer-etag"' },
    [`navigation/nyc/${generation}/manifest.json`]: { body: '{"version":1}', etag: '"manifest-etag"' },
    [`navigation/nyc/${generation}/streets/z14-4829-6165.json`]: { body: '{"version":1}', etag: '"street-etag"' },
    [`navigation/nyc/${generation}/shades/z14-4829-6165.json`]: { body: '{"version":1}', etag: '"shade-index-etag"' },
    [`navigation/nyc/${generation}/shades/z14-4829-6165.bin`]: { body: "0123456789", etag: '"shade-bin-etag"' },
  });
  const shadow = bucketWith(objects);
  return {
    env: {
      SHADOW_TILES: shadow,
      NAVIGATION_DATA: navigation,
      ALLOWED_ORIGIN: "https://shademapnav.vercel.app",
      LEGACY_GENERATIONS: "",
    } as unknown as Env,
    navigation,
    shadow,
  };
}

function request(path: string, method = "GET", origin?: string): Request {
  const headers = origin ? new Headers({ Origin: origin }) : undefined;
  return new Request(`https://data.example.com${path}`, { method, headers });
}

describe("navigation allow-list", () => {
  it("serves the pointer, manifest, notices, and every shard kind", () => {
    expect(navigationKey("/navigation/nyc/current.json")).toBe("navigation/nyc/current.json");
    expect(navigationKey(`/navigation/nyc/${generation}/manifest.json`)).toBe(
      `navigation/nyc/${generation}/manifest.json`,
    );
    expect(navigationKey(`/navigation/nyc/${generation}/notices.json`)).toBe(
      `navigation/nyc/${generation}/notices.json`,
    );
    expect(navigationKey(`/navigation/nyc/${generation}/streets/z14-4829-6165.json`)).toBe(
      `navigation/nyc/${generation}/streets/z14-4829-6165.json`,
    );
    expect(navigationKey(`/navigation/nyc/${generation}/buildings/z13-2300-3000.json`)).toBe(
      `navigation/nyc/${generation}/buildings/z13-2300-3000.json`,
    );
    // L2a: the shade table's index and its slot-major payload.
    expect(navigationKey(`/navigation/nyc/${generation}/shades/z14-4829-6165.json`)).toBe(
      `navigation/nyc/${generation}/shades/z14-4829-6165.json`,
    );
    expect(navigationKey(`/navigation/nyc/${generation}/shades/z14-4829-6165.bin`)).toBe(
      `navigation/nyc/${generation}/shades/z14-4829-6165.bin`,
    );
  });

  it("rejects listing, sibling prefixes, and arbitrary keys", () => {
    for (const path of [
      "/navigation/nyc/",
      "/navigation/",
      "/navigation",
      "/navigation/nyc/other.json",
      "/transit/nyc/current.json",
      "/_shadow/current.json",
      `/navigation/nyc/${generation}/raw/private.json`,
      `/navigation/nyc/${generation}/streets/z14-4829-6165.json.bak`,
      `/navigation/nyc/${generation}/shades/z14-4829-6165.txt`,
      `/navigation/nyc/${generation}/shades/z14-4829-6165.bin.bak`,
      "/navigation/nyc/current.json/extra",
      `/_shadow/navigation/nyc/${generation}/manifest.json`,
    ]) {
      expect(navigationKey(path)).toBeUndefined();
    }
  });

  it("rejects traversal-syntax and malformed generation or cell names", () => {
    // Dot segments are resolved by URL parsing itself (same in workerd), so
    // `..` can only travel within already-allow-listed prefixes.
    expect(navigationKey("/navigation/nyc/current.json/../current.json")).toBe(
      "navigation/nyc/current.json",
    );
    expect(navigationKey("/navigation/nyc/current%2ejson")).toBeUndefined();
    expect(navigationKey("/navigation/nyc/current.json%2f..")).toBeUndefined();
    expect(navigationKey(`/navigation/nyc/${generation}/streets/../..//current.json`)).toBeUndefined();
    expect(navigationKey(`/navigation/nyc/${generation}/../../../current.json`)).toBeUndefined();
    expect(navigationKey("/navigation%2fnyc/current.json")).toBeUndefined();
    expect(navigationKey("/navigation/nyc/nyc-2026-09-18-9f2924750af1-extra/manifest.json")).toBeUndefined();
    expect(navigationKey("/navigation/nyc/nyc-2026-09-18-9F2924750AF1/manifest.json")).toBeUndefined();
    expect(navigationKey("/navigation/nyc/nyc-2026-09-18-9f2924750af/manifest.json")).toBeUndefined();
    expect(navigationKey(`/navigation/nyc/${generation}/streets/z14-4829-6165.JSON`)).toBeUndefined();
  });

  it("matches the allow-list on the pathname, never the query string", () => {
    expect(navigationKey("/navigation/nyc/current.json?x=/../../raw")).toBe(
      "navigation/nyc/current.json",
    );
    expect(navigationKey(`/navigation/nyc/${generation}/manifest.json?traversal=../..`)).toBe(
      `navigation/nyc/${generation}/manifest.json`,
    );
  });

  it("leaves the _shadow allow-list untouched", () => {
    const shadowV1 = "nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v1";
    expect(requestedKey(new URL("https://data.example.com/_shadow/current.json"))).toBe("current.json");
    expect(
      requestedKey(
        new URL(
          `https://data.example.com/_shadow/generations/${shadowV1}/tiles/18-77123-98543.smb`,
        ),
      ),
    ).toBe("generations/" + shadowV1 + "/tiles/18-77123-98543.smb");
    expect(navigationKey(`/_shadow/generations/${shadowV1}/manifest.json`)).toBeUndefined();
  });
});

describe("navigation fetch routing", () => {
  it("serves navigation objects from NAVIGATION_DATA, headers exact", async () => {
    const { env, navigation } = envWith({});
    const response = await worker.fetch(request("/navigation/nyc/current.json"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("ETag")).toBe('"pointer-etag"');
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await response.text()).toBe('{"version":1}');
    expect(navigation.calls).toContain("get:navigation/nyc/current.json");

    const manifest = await worker.fetch(
      request(`/navigation/nyc/${generation}/manifest.json`),
      env,
    );
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("Content-Type")).toBe("application/json");
    expect(manifest.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(manifest.headers.get("ETag")).toBe('"manifest-etag"');

    const shard = await worker.fetch(
      request(`/navigation/nyc/${generation}/streets/z14-4829-6165.json`),
      env,
    );
    expect(shard.status).toBe(200);
    expect(shard.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("passes Range through to R2 and answers 206 for the shade payload", async () => {
    const { env } = envWith({});
    const binPath = `/navigation/nyc/${generation}/shades/z14-4829-6165.bin`;
    const withRange = (value: string) =>
      new Request(`https://data.example.com${binPath}`, { headers: new Headers({ Range: value }) });

    const ranged = await worker.fetch(withRange("bytes=2-5"), env);
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(ranged.headers.get("Content-Length")).toBe("4");
    expect(ranged.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await ranged.text()).toBe("2345");

    // A suffix range resolves against the object's own size.
    const suffix = await worker.fetch(withRange("bytes=-3"), env);
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");

    // Open-ended range, and no Range header at all.
    expect((await worker.fetch(withRange("bytes=8-"), env)).headers.get("Content-Range")).toBe("bytes 8-9/10");
    const full = await worker.fetch(request(binPath), env);
    expect(full.status).toBe(200);
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await full.text()).toBe("0123456789");

    // A malformed range falls back to the whole object rather than erroring.
    expect((await worker.fetch(withRange("bytes=abc"), env)).status).toBe(200);
  });

  it("keeps shadow keys on SHADOW_TILES even when NAVIGATION_DATA has no such key", async () => {
    const { env, shadow } = envWith({
      "_shadow-note": { body: '{"ok":1}', etag: '"se"' },
    });
    // Request a _shadow current.json while NAVIGATION_DATA is populated; the
    // shadow bucket (empty here) must be the one consulted.
    const response = await worker.fetch(request("/_shadow/current.json"), env);
    expect(response.status).toBe(404);
    expect(shadow.calls).toContain("get:current.json");
  });

  it("answers HEAD without a body and with the same headers", async () => {
    const { env } = envWith({});
    const response = await worker.fetch(
      request(`/navigation/nyc/${generation}/manifest.json`, "HEAD"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"manifest-etag"');
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("");
  });

  it("rejects writes and unsupported methods on allow-listed paths", async () => {
    const { env } = envWith({});
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await worker.fetch(request("/navigation/nyc/current.json", method), env);
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method not allowed");
    }
  });

  it("answers the CORS preflight for the allowed origin", async () => {
    const { env } = envWith({});
    const response = await worker.fetch(
      request("/navigation/nyc/current.json", "OPTIONS", "https://shademapnav.vercel.app"),
      env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://shademapnav.vercel.app");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("sends CORS headers only to the allowed origin", async () => {
    const { env } = envWith({});
    for (const origin of ["https://evil.example.com", "http://localhost:5173"]) {
      const denied = await worker.fetch(request("/navigation/nyc/current.json", "GET", origin), env);
      expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(denied.headers.get("Vary")).toBe("Origin");
    }
  });

  it("missing objects are uncacheable 404s", async () => {
    const { env } = envWith({});
    const response = await worker.fetch(
      request(`/navigation/nyc/${generation}/streets/z14-9999-9999.json`),
      env,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
