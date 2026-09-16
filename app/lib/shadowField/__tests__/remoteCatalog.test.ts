import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadGenerationRoot,
  loadCoverageIndex,
  loadShadowCurrent,
  parseShadowCurrent,
  shadowApiBase,
} from "../remoteCatalog";
import { artifactBytes } from "../v2/artifacts";

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

  it("rejects generation traversal and path mismatches", () => {    const traversal = "../../../etc/passwd";
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

describe("remoteCatalog v2 pointer", () => {
  const generation = "nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v2";

  function validV2Pointer() {
    return {
      version: 2,
      dataset: "nyc-shadow",
      generation,
      generationPath: `/_shadow/generations/${generation}/generation.json`,
      generationSha256: "b".repeat(64),
      tilePathTemplate: `/_shadow/generations/${generation}/tiles/{z}-{x}-{y}.smb`,
      tileCount: 61442,
    };
  }

  it("parses a v2 generation-root pointer", () => {
    const parsed = parseShadowCurrent(validV2Pointer());
    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("expected v2");
    expect(parsed.generationPath).toContain("generation.json");
  });

  it("rejects v2 pointers with mismatched root paths or hashes", () => {
    expect(() =>
      parseShadowCurrent({ ...validV2Pointer(), generationPath: "/_shadow/other.json" }),
    ).toThrow(/pointer/);
    expect(() => parseShadowCurrent({ ...validV2Pointer(), generationSha256: "zz" })).toThrow(
      /pointer/,
    );
    expect(() => parseShadowCurrent({ ...validV2Pointer(), version: 3 })).toThrow(/pointer/);
    expect(() => parseShadowCurrent({ ...validV2Pointer(), tileCount: 0 })).toThrow(/pointer/);
  });
});

describe("remoteCatalog generation root fetch", () => {
  const generation = "nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v2";
  const ref = (filename: string) => ({
    path: `/_shadow/generations/${generation}/${filename}`,
    sha256: "c".repeat(64),
    bytes: 100,
  });

  function rootBody() {
    return {
      version: 1,
      generation,
      identity: {
        recipeHash: "d".repeat(64),
        datumHash: "d".repeat(64),
        hierarchyHash: "d".repeat(64),
        normalizerHash: "d".repeat(64),
        compositorHash: "d".repeat(64),
        treeModelHash: "d".repeat(64),
        receiverHash: "d".repeat(64),
      },
      artifacts: {
        manifest: { ...ref("manifest.json"), bytes: 1000 },
        coverage: ref("coverage.json"),
        bounds: ref("bounds.json"),
        notices: ref("notices.json"),
      },
      tilePathTemplate: `/_shadow/generations/${generation}/tiles/{z}-{x}-{y}.smb`,
      tileCount: 61442,
      availableTileCount: 61442,
      activationTileCount: 60000,
      maxDecodedBytes: { coverage: 2097152, bounds: 6291456, notices: 262144 },
    };
  }

  async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function pointerFor(digest: string) {
    return {
      version: 2 as const,
      dataset: "nyc-shadow" as const,
      generation,
      generationPath: `/_shadow/generations/${generation}/generation.json`,
      generationSha256: digest,
      tilePathTemplate: `/_shadow/generations/${generation}/tiles/{z}-{x}-{y}.smb`,
      tileCount: 61442,
    };
  }

  it("verifies root bytes against the pointer before parsing", async () => {
    vi.stubEnv("VITE_SHADOW_API_BASE", "https://example.com");
    const bytes = artifactBytes(rootBody());
    const digest = await sha256Hex(bytes);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer }),
    );
    const root = await loadGenerationRoot(pointerFor(digest));
    expect(root.availableTileCount).toBe(61442);
  });

  it("fails closed on hash mismatch and oversized roots", async () => {
    vi.stubEnv("VITE_SHADOW_API_BASE", "https://example.com");
    const bytes = artifactBytes(rootBody());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer }),
    );
    await expect(loadGenerationRoot(pointerFor("0".repeat(64)))).rejects.toThrow(/hash mismatch/);
    const big = new Uint8Array(300 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => big.buffer }),
    );
    const digest = await sha256Hex(big);
    await expect(loadGenerationRoot(pointerFor(digest))).rejects.toThrow(/budget/);
  });

  it("fetches coverage only through its root hash/ref and enforces count relationships", async () => {
    vi.stubEnv("VITE_SHADOW_API_BASE", "https://example.com");
    const coverage = {
      version: 1,
      generation,
      available: { rows: [{ y: 1, runs: [[1, 2]] }], count: 2 },
      activation: { rows: [{ y: 1, runs: [[1, 1]] }], count: 1 },
      activationRule: "test",
      activationBoundary: null,
      availableTileCount: 2,
      activationTileCount: 1,
    };
    const coverageBytes = artifactBytes(coverage);
    const coverageHash = await sha256Hex(coverageBytes);
    const body = rootBody();
    body.tileCount = 2; body.availableTileCount = 2; body.activationTileCount = 1;
    body.artifacts.coverage = { ...body.artifacts.coverage, bytes: coverageBytes.byteLength, sha256: coverageHash };
    const rootBytes = artifactBytes(body);
    const rootHash = await sha256Hex(rootBytes);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => rootBytes.buffer })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => coverageBytes.buffer }));
    const root = await loadGenerationRoot({ ...pointerFor(rootHash), tileCount: 2 });
    // Pointer's tile count is part of the root contract, not advisory.
    await expect(loadCoverageIndex(root)).resolves.toMatchObject({ availableTileCount: 2, activationTileCount: 1 });
  });
});
