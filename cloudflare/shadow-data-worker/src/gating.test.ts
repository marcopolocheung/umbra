import { describe, expect, it } from "vitest";
import { generationNeedsMarker, requestedKey } from "./index";

const v1 = "nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v1";
const v2 = "nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v2";
const legacy = new Set([v1]);

function key(path: string): string | undefined {
  return requestedKey(new URL(`https://example.com${path}`));
}

describe("worker allow-list", () => {
  it("serves the pointer, generation assets, and nothing else", () => {
    expect(key("/_shadow/current.json")).toBe("current.json");
    expect(key(`/_shadow/generations/${v2}/tiles/18-77123-98543.smb`)).toContain("tiles/18-77123-98543.smb");
    expect(key(`/_shadow/generations/${v2}/generation.json`)).toContain("generation.json");
    expect(key(`/_shadow/generations/${v2}/coverage.json`)).toContain("coverage.json");
    expect(key(`/_shadow/generations/${v2}/bounds.json`)).toContain("bounds.json");
    expect(key(`/_shadow/generations/${v2}/notices.json`)).toContain("notices.json");
    expect(key(`/_shadow/generations/${v2}/manifest.json`)).toContain("manifest.json");
    expect(key("/_shadow/normalized/private-object")).toBeUndefined();
    expect(key(`/_shadow/generations/${v2}/shards/000-of-128.json`)).toBeUndefined();
    expect(key(`/_shadow/generations/${v2}/manifest.json/../secret`)).toBeUndefined();
    expect(key(`/_shadow/generations/${v2}/notes.txt`)).toBeUndefined();
  });
});

describe("worker publication gating", () => {
  it("grandfathers only legacy manifests and tiles", () => {
    expect(generationNeedsMarker(v1, "manifest.json", legacy)).toBe(false);
    expect(generationNeedsMarker(v1, "tiles/18-1-1.smb", legacy)).toBe(false);
    expect(generationNeedsMarker(v1, "coverage.json", legacy)).toBe(true);
    expect(generationNeedsMarker(v1, "generation.json", legacy)).toBe(false);
  });

  it("gates every non-legacy generation asset on its root marker", () => {
    for (const file of [
      "manifest.json",
      "tiles/18-77123-98543.smb",
      "generation.json",
      "coverage.json",
      "bounds.json",
      "notices.json",
    ]) {
      // Only the root marker itself is exempt; every other non-legacy asset
      // waits for it.
      expect(generationNeedsMarker(v2, file, legacy)).toBe(file !== "generation.json");
    }
    expect(generationNeedsMarker(v2, "manifest.json", new Set([v2]))).toBe(false);
  });
});
