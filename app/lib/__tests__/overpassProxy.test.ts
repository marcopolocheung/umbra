import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredOverpassEndpoints,
  DEFAULT_OVERPASS_ENDPOINTS,
  requestOverpass,
} from "../../../server/overpassProxy.js";

const QUIET_LOGGER = { info: vi.fn() };

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function upstreamResponse(
  status: number,
  body = `status-${status}`,
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => body,
  };
}

function makeReq({
  body = "data=%5Bout%3Ajson%5D%3B",
  headers = {},
}: {
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  return Object.assign(new EventEmitter(), {
    method: "POST",
    body,
    headers,
  });
}

function makeRes() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    jsonBody: null as Record<string, unknown> | null,
    sentBody: "",
    writableEnded: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    json(body: Record<string, unknown>) {
      this.jsonBody = body;
      this.writableEnded = true;
      return this;
    },
    send(body: string) {
      this.sentBody = body;
      this.writableEnded = true;
      return this;
    },
  });
}

async function loadHandler() {
  const mod = await import("../../../api/overpass.js");
  return mod.default as (
    req: ReturnType<typeof makeReq>,
    res: ReturnType<typeof makeRes>,
  ) => Promise<void>;
}

describe("Overpass endpoint configuration", () => {
  it("uses the three providers in the required default order", () => {
    expect(configuredOverpassEndpoints({}).map((endpoint) => endpoint.url)).toEqual(
      DEFAULT_OVERPASS_ENDPOINTS,
    );
  });

  it("supports a comma-separated endpoint override and adds the interpreter path", () => {
    expect(
      configuredOverpassEndpoints({
        OVERPASS_ENDPOINTS: "one.example, https://two.example/custom",
      }),
    ).toEqual([
      { label: "one.example", url: "https://one.example/api/interpreter" },
      { label: "two.example", url: "https://two.example/custom" },
    ]);
  });
});

describe("Overpass retry strategy", () => {
  const endpoints = configuredOverpassEndpoints({});

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([429, 500, 502, 503, 504])("fails over after retryable HTTP %s", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstreamResponse(status))
      .mockResolvedValueOnce(upstreamResponse(200, "ok"));

    const response = await requestOverpass("data=safe", {
      endpoints,
      fetchImpl: fetchMock,
      logger: QUIET_LOGGER,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      endpoints.slice(0, 2).map((endpoint) => endpoint.url),
    );
    expect(response).toMatchObject({ status: 200, body: "ok" });
  });

  it("fails over after a network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce(upstreamResponse(200, "ok"));

    const response = await requestOverpass("data=safe", {
      endpoints,
      fetchImpl: fetchMock,
      logger: QUIET_LOGGER,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it("immediately forwards a non-retryable 4xx query response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstreamResponse(400, "bad query"));

    const response = await requestOverpass("data=safe", {
      endpoints,
      fetchImpl: fetchMock,
      logger: QUIET_LOGGER,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ status: 400, body: "bad query" });
  });

  it("forwards successful status, body, content type, and retry metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      upstreamResponse(200, '{"elements":[]}', {
        "Content-Type": "application/json",
        "Retry-After": "12",
        "X-Internal": "do-not-forward",
      }),
    );

    const response = await requestOverpass("data=safe", {
      endpoints,
      fetchImpl: fetchMock,
      logger: QUIET_LOGGER,
    });

    expect(response).toEqual({
      status: 200,
      headers: { "Content-Type": "application/json", "Retry-After": "12" },
      body: '{"elements":[]}',
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: "data=safe",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Umbra/1.0 (+https://shademapnav.vercel.app)",
      },
    });
  });

  it("limits each attempt and tries the next provider after a timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(abortError()));
          }),
      )
      .mockResolvedValueOnce(upstreamResponse(200, "ok"));

    const pending = requestOverpass("data=safe", {
      endpoints,
      fetchImpl: fetchMock,
      logger: QUIET_LOGGER,
      attemptTimeoutMs: 8_000,
      totalTimeoutMs: 26_000,
    });
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toMatchObject({ status: 200, body: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops when the total budget expires instead of starting a fresh attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    );

    const pending = requestOverpass("data=safe", {
      endpoints,
      fetchImpl: fetchMock,
      logger: QUIET_LOGGER,
      attemptTimeoutMs: 8_000,
      totalTimeoutMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels the current upstream when its downstream signal aborts", async () => {
    const downstream = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(abortError()));
      });
    });

    const pending = requestOverpass("data=safe", {
      endpoints,
      fetchImpl: fetchMock,
      logger: QUIET_LOGGER,
      signal: downstream.signal,
    });
    downstream.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs only endpoint metadata, never a query or coordinates", async () => {
    const logger = { info: vi.fn() };
    const secretBody = "data=way(41.8781,-87.6298,41.879,-87.62);out;";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(upstreamResponse(200, "ok"));

    await requestOverpass(secretBody, { endpoints, fetchImpl: fetchMock, logger });

    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).toContain("overpass-api.de");
    expect(logged).toContain("network");
    expect(logged).not.toContain("way(");
    expect(logged).not.toContain("41.8781");
    expect(logged).not.toContain("-87.6298");
  });
});

describe("api/overpass handler", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.spyOn(console, "info").mockImplementation(() => {});
    delete process.env.OVERPASS_ENDPOINTS;
    delete process.env.OVERPASS_MAX_BODY_BYTES;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [{ "content-length": "20" }, "short"],
    [{}, "data=too-large"],
  ])("rejects oversized requests before forwarding", async (headers, body) => {
    process.env.OVERPASS_MAX_BODY_BYTES = "8";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq({ body, headers }), res);

    expect(res.statusCode).toBe(413);
    expect(res.jsonBody?.error).toBe("Overpass request is too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a stable 503 with Retry-After after exhausting the pool", async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstreamResponse(503));
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq(), res);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("30");
    const body = JSON.parse(res.sentBody);
    expect(body.error).toBe("Map data service temporarily unavailable");
    // One entry per mirror, saying why each gave up — the two causes this
    // distinguishes have opposite fixes, and server logs expire.
    expect(body.attempts).toHaveLength(3);
    expect(body.attempts[0]).toMatchObject({
      endpoint: "overpass-api.de",
      attempt: 1,
      status: 503,
      failureClass: "retryable_http",
    });
    expect(typeof body.attempts[0].durationMs).toBe("number");
  });

  it("reports an attempt timeout distinctly from a refusal", async () => {
    // The whole point of the field: a mirror that is merely slow looks nothing
    // like one that is rate-limiting, and the two are fixed differently.
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    );

    const pending = requestOverpass("data=safe", {
      endpoints: configuredOverpassEndpoints({}),
      fetchImpl: fetchMock,
      logger: QUIET_LOGGER,
      attemptTimeoutMs: 8_000,
      totalTimeoutMs: 26_000,
    });
    await vi.advanceTimersByTimeAsync(26_000);
    const res = await pending;

    expect(res.status).toBe(503);
    const classes = JSON.parse(res.body).attempts.map(
      (a: { failureClass: string }) => a.failureClass,
    );
    expect(classes).toContain("attempt_timeout");
    expect(classes).not.toContain("retryable_http");
  });

  it("never puts a query or a coordinate in the 503 body", async () => {
    // The response now leaves the server, so it is held to the same rule the
    // log line is: endpoint metadata only.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstreamResponse(429)));
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.sentBody).not.toContain("way(");
    expect(res.sentBody).not.toContain("41.8781");
    expect(res.sentBody).not.toContain("data=");
  });

  it("aborts the in-flight upstream when the request is abandoned", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(abortError()));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const req = makeReq();
    const res = makeRes();

    const pending = handler(req, res);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    req.emit("aborted");
    await pending;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(res.writableEnded).toBe(false);
  });
});
