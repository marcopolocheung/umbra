import { beforeEach, describe, expect, it, vi } from "vitest";

// Ensure auth-block logic doesn't touch real sessionStorage in node tests.
vi.stubGlobal("sessionStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
} as unknown as Storage);

describe("foursquare service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
  });

  it("sanitizes trailing OSM id suffixes in addresses", async () => {
    // Pure sanitizer behavior
    const { sanitizeFoursquareAddress } = await import("../foursquare");
    expect(sanitizeFoursquareAddress("Madonnina del Duomo, 1_33051")).toBe(
      "Madonnina del Duomo, 1"
    );
    expect(sanitizeFoursquareAddress("  Hello_123  ")).toBe("Hello");
    expect(sanitizeFoursquareAddress("NoSuffix")).toBe("NoSuffix");
  });

  it("uses Places API endpoints + Bearer Authorization header when fetching place info", async () => {
    const fetchMock = vi.fn()
      // Search call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ fsq_id: "abc123" }] }),
      })
      // Details call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: "Test Place",
          location: { formatted_address: "Somewhere" },
          categories: [{ name: "Cafe" }],
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    // Dynamic import so module reads env + binds fetch after our stubs.
    const mod = await import("../foursquare");

    const res = await mod.getPlaceInfoFromAddress("Madonnina del Duomo, 1", 1, 2, {
      apiKey: "test_key_123",
    });
    expect(res?.name).toBe("Test Place");
    expect(res?.fsqId).toBe("abc123");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [searchUrl, searchInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [detailsUrl, detailsInit] = fetchMock.mock.calls[1] as [string, RequestInit];

    expect(searchUrl).toMatch(/^\/__fsq\/places\/search\?/);
    expect(detailsUrl).toMatch(/^\/__fsq\/places\/abc123\?/);
    expect(detailsUrl).toMatch(/[?&]fields=/);

    // New API expects Bearer token
    expect((searchInit.headers as any).Authorization).toBe("Bearer test_key_123");
    expect((detailsInit.headers as any).Authorization).toBe("Bearer test_key_123");
  });

  it("fetches place details by fsq_id and caches the result", async () => {
    const fetchMock = vi.fn()
      // Details call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: "Detail Place",
          location: { formatted_address: "Detail Address" },
          categories: [{ name: "Museum" }],
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../foursquare");

    const res1 = await mod.getPlaceDetails("abc123", { apiKey: "test_key_123" });
    expect(res1?.name).toBe("Detail Place");
    expect(res1?.fsqId).toBe("abc123");

    // Second call should hit cache.
    const res2 = await mod.getPlaceDetails("abc123", { apiKey: "test_key_123" });
    expect(res2?.name).toBe("Detail Place");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [detailsUrl, detailsInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(detailsUrl).toMatch(/^\/__fsq\/places\/abc123\?/);
    expect(detailsUrl).toMatch(/[?&]fields=/);
    expect((detailsInit.headers as any).Authorization).toBe("Bearer test_key_123");
  });

  it("de-dupes in-flight getPlaceDetails requests for the same fsq_id", async () => {
    // Create a fetch promise we can resolve later so both calls overlap.
    let resolveFetch: ((v: Response) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../foursquare");

    const p1 = mod.getPlaceDetails("dedupe123", { apiKey: "test_key_123" });
    const p2 = mod.getPlaceDetails("dedupe123", { apiKey: "test_key_123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const finishFetch = resolveFetch;
    if (!finishFetch) throw new Error("expected fetch to be in-flight");
    finishFetch({
      ok: true,
      status: 200,
      json: async () => ({ name: "Detail Place" }),
    } as Response);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.name).toBe("Detail Place");
    expect(r2?.name).toBe("Detail Place");
  });

  it("expires cached place details after 1 hour (TTL)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ name: "First" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ name: "Second" }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../foursquare");

    const r1 = await mod.getPlaceDetails("ttl123", { apiKey: "test_key_123" });
    expect(r1?.name).toBe("First");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Within TTL → cache hit
    vi.setSystemTime(new Date("2026-01-01T00:30:00Z"));
    const r2 = await mod.getPlaceDetails("ttl123", { apiKey: "test_key_123" });
    expect(r2?.name).toBe("First");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past TTL → refetch
    vi.setSystemTime(new Date("2026-01-01T01:30:01Z"));
    const r3 = await mod.getPlaceDetails("ttl123", { apiKey: "test_key_123" });
    expect(r3?.name).toBe("Second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("suggestPlaces ranks distance-first and caches per query+anchor", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            fsq_id: "far",
            name: "Far Cafe",
            latitude: 40.01,
            longitude: -74.0,
            categories: [{ name: "Coffee Shop" }],
          },
          {
            fsq_id: "near",
            name: "Near Cafe",
            latitude: 40.0005,
            longitude: -74.0005,
            categories: [{ name: "Bakery" }],
            rating: 8.9,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../foursquare");

    const res = await mod.suggestPlaces("cafe", [-74.0005, 40.0005], { apiKey: "test_key_123" });
    expect(res.map((s) => s.name)).toEqual(["Near Cafe", "Far Cafe"]);
    expect(res[0].distanceM).toBe(0);
    expect(res[0].rating).toBe(8.9);

    // Same query + anchor → cache hit, no second fetch.
    await mod.suggestPlaces("cafe", [-74.0005, 40.0005], { apiKey: "test_key_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Different anchor → refetch.
    await mod.suggestPlaces("cafe", [-74.0, 40.0], { apiKey: "test_key_123" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("suggestPlaces returns [] on auth failure without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../foursquare");

    const res = await mod.suggestPlaces("cafe", [-74.0, 40.0], { apiKey: "test_key_123" });
    expect(res).toEqual([]);
  });

  it("returns null on 410 and caches the null result", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 410,
      json: async () => ({}),
    });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../foursquare");

    const res1 = await mod.getPlaceInfoFromAddress("Some Place", 1, 2, {
      apiKey: "test_key_123",
    });
    expect(res1).toBeNull();

    // Second call should hit cache and not call fetch again.
    const res2 = await mod.getPlaceInfoFromAddress("Some Place", 1, 2, {
      apiKey: "test_key_123",
    });
    expect(res2).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
