import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHED_LIMIT,
  clearShedPermitCache,
  fetchShedPermits,
  parseShedPermits,
  shedPermitQuery,
  todayInNewYork,
} from "../sidewalkSheds";

const TODAY = "2026-09-28";
const MIDTOWN = { west: -73.99, south: 40.75, east: -73.98, north: 40.76 };

function row(job: string, expired: string, lat = "40.7513", lng = "-73.9876") {
  return { job_filing_number: job, latitude: lat, longitude: lng, expired_date: expired };
}

describe("todayInNewYork", () => {
  it("uses New York's calendar, not UTC's", () => {
    // 02:00 UTC is still the previous evening in New York.
    expect(todayInNewYork(Date.parse("2026-09-29T02:00:00Z"))).toBe("2026-09-28");
    expect(todayInNewYork(Date.parse("2026-09-29T05:00:00Z"))).toBe("2026-09-29");
  });
});

describe("shedPermitQuery", () => {
  it("asks for issued, unexpired, geocoded sidewalk sheds inside the bbox", () => {
    const where = shedPermitQuery(MIDTOWN, TODAY).get("$where") ?? "";
    expect(where).toContain("work_type='Sidewalk Shed'");
    expect(where).toContain("permit_status='Permit Issued'");
    expect(where).toContain(`expired_date > '${TODAY}'`);
    expect(where).toContain("latitude IS NOT NULL");
    expect(where).toContain("latitude between 40.75 and 40.76");
    expect(where).toContain("longitude between -73.99 and -73.98");
    expect(shedPermitQuery(MIDTOWN, TODAY).get("$limit")).toBe(String(SHED_LIMIT));
  });
});

describe("parseShedPermits", () => {
  it("keeps unexpired permits and drops ones that lapse today or earlier", () => {
    const permits = parseShedPermits(
      [
        row("A", "2026-11-18T00:00:00.000"),
        row("B", "2026-09-28T04:00:00.000"),
        row("C", "2026-01-01T00:00:00.000"),
      ],
      TODAY,
    );
    expect(permits.map((p) => p.jobFilingNumber)).toEqual(["A"]);
    expect(permits[0]).toMatchObject({ lat: 40.7513, lng: -73.9876 });
  });

  it("drops rows without usable coordinates", () => {
    const permits = parseShedPermits(
      [
        { job_filing_number: "A", expired_date: "2026-12-01T00:00:00.000" },
        row("B", "2026-12-01T00:00:00.000", "not-a-number", "-73.98"),
        row("C", "2026-12-01T00:00:00.000", "0", "0"),
      ],
      TODAY,
    );
    expect(permits).toEqual([]);
  });

  it("keeps one permit per job, the latest expiry", () => {
    const permits = parseShedPermits(
      [row("A", "2026-11-18T00:00:00.000"), row("A", "2026-12-09T00:00:00.000")],
      TODAY,
    );
    expect(permits).toHaveLength(1);
    expect(permits[0].expiresAt).toBe("2026-12-09T00:00:00.000");
  });
});

describe("fetchShedPermits", () => {
  const NOW = Date.parse("2026-09-28T16:00:00Z");
  let fetchMock: ReturnType<typeof vi.fn>;

  function respond(rows: unknown[], ok = true) {
    fetchMock.mockResolvedValueOnce({
      ok,
      status: ok ? 200 : 503,
      json: async () => rows,
    });
  }

  beforeEach(() => {
    clearShedPermitCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed permits and a coverage that contains the request", async () => {
    respond([row("A", "2026-11-18T00:00:00.000")]);
    const result = await fetchShedPermits(
      { west: -73.985, south: 40.752, east: -73.981, north: 40.757 },
      { now: NOW },
    );
    expect(result.permits).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.coverage.west).toBeLessThanOrEqual(-73.985);
    expect(result.coverage.north).toBeGreaterThanOrEqual(40.757);
    expect(String(fetchMock.mock.calls[0][0])).toContain("data.cityofnewyork.us/resource/rbx6-tga4.json");
  });

  it("serves a nearby request from the same fetch within a day", async () => {
    respond([]);
    await fetchShedPermits(MIDTOWN, { now: NOW });
    await fetchShedPermits(
      { west: -73.989, south: 40.751, east: -73.981, north: 40.759 },
      { now: NOW + 60 * 60 * 1000 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches once the day-long cache has expired", async () => {
    respond([]);
    respond([]);
    await fetchShedPermits(MIDTOWN, { now: NOW });
    await fetchShedPermits(MIDTOWN, { now: NOW + 25 * 60 * 60 * 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("evicts a failed fetch so the next call retries", async () => {
    respond([], false);
    await expect(fetchShedPermits(MIDTOWN, { now: NOW })).rejects.toThrow("503");
    respond([row("A", "2026-11-18T00:00:00.000")]);
    const retry = await fetchShedPermits(MIDTOWN, { now: NOW });
    expect(retry.permits).toHaveLength(1);
  });

  it("passes the caller's signal to fetch", async () => {
    respond([]);
    const controller = new AbortController();
    await fetchShedPermits(MIDTOWN, { now: NOW, signal: controller.signal });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });

  it("marks a response that hit the row limit as incomplete", async () => {
    respond(Array.from({ length: SHED_LIMIT }, (_, i) => row(`J${i}`, "2026-11-18T00:00:00.000")));
    const result = await fetchShedPermits(MIDTOWN, { now: NOW });
    expect(result.complete).toBe(false);
  });
});
