import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadShadowCurrent,
  parseShadowCurrent,
  shadowApiBase,
} from "../remoteCatalog";

const generation = "nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v1";
const manifestSha256 = "a".repeat(64);

function validPointer() {
  return {
    version: 1,
    dataset: "nyc-shadow",
    generation,
    manifestPath: `/_shadow/generations/${generation}/manifest.json`,
    manifestSha256,
    tilePathTemplate: `/_shadow/generations/${generation}/tiles/{z}-{x}-{y}.smb`,
    tileCount: 61442,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("remoteCatalog pointer", () => {
  it("parses a valid generation pointer", () => {
    expect(parseShadowCurrent(validPointer()).generation).toBe(generation);
  });

  it("rejects malformed pointers", () => {
    expect(() => parseShadowCurrent({ ...validPointer(), version: 2 })).toThrow(/pointer/);
    expect(() => parseShadowCurrent({ ...validPointer(), dataset: "other" })).toThrow(/pointer/);
    expect(() => parseShadowCurrent({ ...validPointer(), manifestSha256: "zz" })).toThrow(/pointer/);
    expect(() => parseShadowCurrent({ ...validPointer(), tileCount: 0 })).toThrow(/pointer/);
    expect(() => parseShadowCurrent({ ...validPointer(), tileCount: 1.5 })).toThrow(/pointer/);
    expect(() => parseShadowCurrent(null)).toThrow(/pointer/);
    expect(() => parseShadowCurrent([])).toThrow(/pointer/);
  });

  it("rejects generation traversal and path mismatches", () => {
    const traversal = "../../../etc/passwd";
    expect(() =>
      parseShadowCurrent({ ...validPointer(), generation: traversal }),
    ).toThrow(/pointer/);
    expect(() =>
      parseShadowCurrent({
        ...validPointer(),
        manifestPath: "/_shadow/generations/other/manifest.json",
      }),
    ).toThrow(/pointer/);
    expect(() =>
      parseShadowCurrent({
        ...validPointer(),
        manifestPath: `/_shadow/generations/${generation}/manifest.json/../secret`,
      }),
    ).toThrow(/pointer/);
    expect(() =>
      parseShadowCurrent({
        ...validPointer(),
        tilePathTemplate: `/_shadow/generations/${generation}/tiles/{z}-{x}-{y}.png`,
      }),
    ).toThrow(/pointer/);
    expect(() =>
      parseShadowCurrent({
        ...validPointer(),
        generation: "NYC-UPPERCASE-NOT-ALLOWED",
      }),
    ).toThrow(/pointer/);
  });
});

describe("remoteCatalog base", () => {
  it("returns undefined when unconfigured and trims one trailing slash", () => {
    vi.stubEnv("VITE_SHADOW_API_BASE", "");
    expect(shadowApiBase()).toBeUndefined();
    vi.stubEnv(
      "VITE_SHADOW_API_BASE",
      "https://shademap-nyc-shadow-staging.marcoctpolo.workers.dev/",
    );
    expect(shadowApiBase()).toBe("https://shademap-nyc-shadow-staging.marcoctpolo.workers.dev");
  });

  it("rejects non-HTTPS origins, paths, queries, and malformed URLs", () => {
    for (const value of [
      "http://example.com",
      "https://example.com/extra-path",
      "https://example.com?x=1",
      "https://example.com#frag",
      "not-a-url",
    ]) {
      vi.stubEnv("VITE_SHADOW_API_BASE", value);
      expect(() => shadowApiBase()).toThrow(/HTTPS/);
    }
  });
});

describe("remoteCatalog fetch", () => {
  it("returns undefined without configuration and never fetches", async () => {
    vi.stubEnv("VITE_SHADOW_API_BASE", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadShadowCurrent()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches only the tiny pointer with revalidation headers", async () => {
    vi.stubEnv(
      "VITE_SHADOW_API_BASE",
      "https://shademap-nyc-shadow-staging.marcoctpolo.workers.dev",
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => validPointer(),
    });
    vi.stubGlobal("fetch", fetchMock);
    const current = await loadShadowCurrent();
    expect(current?.generation).toBe(generation);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://shademap-nyc-shadow-staging.marcoctpolo.workers.dev/_shadow/current.json",
    );
    expect(init?.headers).toMatchObject({ Accept: "application/json" });
    expect(init?.cache).toBe("no-cache");
  });

  it("fails closed on HTTP errors and invalid bodies", async () => {
    vi.stubEnv("VITE_SHADOW_API_BASE", "https://example.com");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(loadShadowCurrent()).rejects.toThrow(/404/);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 99 }) }),
    );
    await expect(loadShadowCurrent()).rejects.toThrow(/pointer/);
  });
});
