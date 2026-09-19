import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWeatherCache,
  fetchCloudCoverForecast,
  fetchWeatherForecast,
  nearestCloudCover,
  nearestWeatherHour,
  parseWeatherHours,
} from "../weather";

describe("nearestCloudCover", () => {
  it("returns the nearest hourly cloud cover sample", () => {
    const result = nearestCloudCover(
      {
        hourly: {
          time: ["2026-08-08T14:00", "2026-08-08T15:00", "2026-08-08T16:00"],
          cloud_cover: [15, 74, 90],
        },
      },
      new Date("2026-08-08T15:20:00.000Z")
    );

    expect(result?.cloudCoverPct).toBe(74);
    expect(result?.forecastTime.toISOString()).toBe("2026-08-08T15:00:00.000Z");
  });

  it("clamps cloud cover into a displayable percent", () => {
    const result = nearestCloudCover(
      { hourly: { time: ["2026-08-08T15:00"], cloud_cover: [120] } },
      new Date("2026-08-08T15:00:00.000Z")
    );

    expect(result?.cloudCoverPct).toBe(100);
  });

  it("returns null when the forecast window does not cover the target hour", () => {
    const result = nearestCloudCover(
      { hourly: { time: ["2026-08-08T15:00"], cloud_cover: [80] } },
      new Date("2026-08-08T20:00:00.000Z")
    );

    expect(result).toBeNull();
  });
});

describe("parseWeatherHours", () => {
  it("transposes one row per hour across every requested variable", () => {
    const hours = parseWeatherHours({
      hourly: {
        time: ["2026-08-08T14:00", "2026-08-08T15:00"],
        cloud_cover: [15, 74],
        uv_index: [7.2, 6.1],
        temperature_2m: [31.4, 30.8],
        relative_humidity_2m: [55, 58],
        wind_speed_10m: [3.2, 2.9],
        wind_direction_10m: [210, 235],
        wind_gusts_10m: [6.4, 5.1],
        apparent_temperature: [35.1, 34.2],
        shortwave_radiation: [812, 640],
      },
    });

    expect(hours).toHaveLength(2);
    expect(hours[0].time.toISOString()).toBe("2026-08-08T14:00:00.000Z");
    expect(hours[0].uvIndex).toBe(7.2);
    expect(hours[0].shortwaveWm2).toBe(812);
    expect(hours[1].apparentTempC).toBe(34.2);
    // Wind-from bearing and gusts ride the same transposed row.
    expect(hours[0].windDirDeg).toBe(210);
    expect(hours[1].windGustMs).toBe(5.1);
  });

  it("marks a variable the response omits as null rather than zero", () => {
    // A zero here would read as "no UV", which is a very different claim.
    const [hour] = parseWeatherHours({
      hourly: { time: ["2026-08-08T14:00"], cloud_cover: [15] },
    });

    expect(hour.cloudPct).toBe(15);
    expect(hour.uvIndex).toBeNull();
    expect(hour.tempC).toBeNull();
    expect(hour.shortwaveWm2).toBeNull();
    expect(hour.windDirDeg).toBeNull();
    expect(hour.windGustMs).toBeNull();
  });

  it("drops an hour whose timestamp will not parse", () => {
    const hours = parseWeatherHours({
      hourly: { time: ["not-a-time", "2026-08-08T15:00"], cloud_cover: [10, 20] },
    });

    expect(hours).toHaveLength(1);
    expect(hours[0].cloudPct).toBe(20);
  });
});

describe("nearestWeatherHour", () => {
  const hours = parseWeatherHours({
    hourly: {
      time: ["2026-08-08T14:00", "2026-08-08T15:00"],
      cloud_cover: [15, 74],
      uv_index: [7.2, Number.NaN],
    },
  });

  it("skips an hour missing the field the caller requires", () => {
    // 15:00 is nearer, but carries no UV — so the answer is 14:00, not nothing.
    const hour = nearestWeatherHour(hours, new Date("2026-08-08T15:10:00.000Z"), "uvIndex");

    expect(hour?.time.toISOString()).toBe("2026-08-08T14:00:00.000Z");
    expect(hour?.uvIndex).toBe(7.2);
  });

  it("returns the nearest hour when no field is required", () => {
    const hour = nearestWeatherHour(hours, new Date("2026-08-08T15:10:00.000Z"));

    expect(hour?.time.toISOString()).toBe("2026-08-08T15:00:00.000Z");
  });

  it("returns null past the 90-minute match window", () => {
    expect(nearestWeatherHour(hours, new Date("2026-08-08T20:00:00.000Z"))).toBeNull();
  });
});

describe("fetchWeatherForecast caching", () => {
  const body = {
    hourly: {
      time: ["2026-08-08T15:00"],
      cloud_cover: [74],
      uv_index: [7.2],
    },
  };

  function stubFetch() {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  beforeEach(() => clearWeatherCache());
  afterEach(() => vi.unstubAllGlobals());

  it("serves the cloud badge and UV from a single request", async () => {
    const spy = stubFetch();
    const target = new Date("2026-08-08T15:00:00.000Z");

    const cloud = await fetchCloudCoverForecast(1.3, 103.8, target);
    const hours = await fetchWeatherForecast(1.3, 103.8);

    expect(cloud?.cloudCoverPct).toBe(74);
    expect(nearestWeatherHour(hours, target, "uvIndex")?.uvIndex).toBe(7.2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("asks Open-Meteo for every variable the app needs, in one call", async () => {
    const spy = stubFetch();
    await fetchWeatherForecast(1.3, 103.8);

    const url = String(spy.mock.calls[0][0]);
    for (const variable of [
      "cloud_cover", "uv_index", "temperature_2m",
      "relative_humidity_2m", "wind_speed_10m", "apparent_temperature",
      "shortwave_radiation",
    ]) {
      expect(url).toContain(variable);
    }
  });

  it("asks for wind in the unit `windMs` claims", async () => {
    // Open-Meteo answers in km/h unless told otherwise, and the heat model divides
    // by this number as if it were m/s.
    const spy = stubFetch();
    await fetchWeatherForecast(1.3, 103.8);

    expect(String(spy.mock.calls[0][0])).toContain("wind_speed_unit=ms");
  });

  it("reuses one forecast across a moved timeline, and refetches once it is stale", async () => {
    const spy = stubFetch();

    await fetchWeatherForecast(1.3, 103.8, { now: 0 });
    await fetchWeatherForecast(1.3, 103.8, { now: 59 * 60 * 1000 });
    expect(spy).toHaveBeenCalledTimes(1);

    await fetchWeatherForecast(1.3, 103.8, { now: 61 * 60 * 1000 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("treats a real move as a different location", async () => {
    const spy = stubFetch();

    await fetchWeatherForecast(1.3, 103.8, { now: 0 });
    await fetchWeatherForecast(1.3004, 103.8004, { now: 0 }); // same ~1 km cell
    expect(spy).toHaveBeenCalledTimes(1);

    await fetchWeatherForecast(1.35, 103.85, { now: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a failed request", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", spy);

    await expect(fetchWeatherForecast(1.3, 103.8, { now: 0 })).rejects.toThrow("503");
    // The next caller gets a real attempt, not the cached rejection.
    await expect(fetchWeatherForecast(1.3, 103.8, { now: 0 })).resolves.toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
