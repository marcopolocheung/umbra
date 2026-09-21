import { beforeEach, describe, expect, it, vi } from "vitest";

type JsonBody = Record<string, unknown>;

function makeReq({
  method = "GET",
  url = "/api/fsq/places/search?query=park&ll=40,-74&limit=1",
  headers = {},
  ip = "203.0.113.50",
}: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  ip?: string;
} = {}) {
  return {
    method,
    url,
    headers: {
      referer: "https://shademapnav.vercel.app/",
      // No authorization: since #218 the browser sends none and the proxy
      // injects FSQ_API_KEY itself.
      "x-places-api-version": "2025-06-17",
      "x-forwarded-for": ip,
      ...headers,
    },
    socket: { remoteAddress: ip },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    jsonBody: null as JsonBody | null,
    sentBody: "",
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    json(body: JsonBody) {
      this.jsonBody = body;
      return this;
    },
    send(body: string) {
      this.sentBody = body;
      return this;
    },
  };
}

async function loadHandler() {
  const mod = await import("../../../api/fsq.js");
  return mod.default as (req: ReturnType<typeof makeReq>, res: ReturnType<typeof makeRes>) => Promise<void>;
}

describe("api/fsq proxy hardening", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.FSQ_ALLOWED_ORIGINS;
    delete process.env.FSQ_RATE_LIMIT_PER_MIN;
    delete process.env.VERCEL_URL;
    process.env.FSQ_API_KEY = "server_side_fsq_key";
  });

  it("rejects browser sources outside the allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq({ headers: { referer: "https://example.invalid/" } }), res);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody?.error).toBe("Origin not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests without an origin or referer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq({ headers: { referer: undefined as unknown as string } }), res);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody?.error).toBe("Origin not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Foursquare paths outside the app allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq({ url: "/api/fsq/users/self" }), res);

    expect(res.statusCode).toBe(404);
    expect(res.jsonBody?.error).toBe("Foursquare path is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limits repeated requests from one IP", async () => {
    process.env.FSQ_RATE_LIMIT_PER_MIN = "1";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: async () => "{\"ok\":true}",
    }));
    const handler = await loadHandler();

    const first = makeRes();
    await handler(makeReq({ ip: "203.0.113.60" }), first);
    expect(first.statusCode).toBe(200);

    const second = makeRes();
    await handler(makeReq({ ip: "203.0.113.60" }), second);
    expect(second.statusCode).toBe(429);
    expect(second.jsonBody?.error).toMatch(/Too many Foursquare requests/);
  });

  it("forwards allowed place search requests and rate-limit headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": "12",
      }),
      text: async () => "{\"results\":[]}",
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.headers["X-RateLimit-Remaining"]).toBe("12");
    expect(res.sentBody).toBe("{\"results\":[]}");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://places-api.foursquare.com/places/search?query=park&ll=40,-74&limit=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer server_side_fsq_key",
          "X-Places-Api-Version": "2025-06-17",
        }),
      })
    );
  });

  it("refuses to serve when FSQ_API_KEY is unset, rather than falling back to the caller", async () => {
    // The pre-#218 proxy relayed whatever Authorization the browser sent, which
    // is why the key had to be in the bundle. A fallback here would quietly
    // restore that, so an unconfigured deploy must fail instead.
    delete process.env.FSQ_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(
      makeReq({ headers: { authorization: "Bearer attacker_supplied_key" } }),
      res
    );

    expect(res.statusCode).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores an Authorization header supplied by the caller", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: async () => "{\"results\":[]}",
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(
      makeReq({ headers: { authorization: "Bearer attacker_supplied_key" } }),
      res
    );

    expect(res.statusCode).toBe(200);
    const sent = fetchMock.mock.calls[0][1].headers.Authorization;
    expect(sent).toBe("Bearer server_side_fsq_key");
  });

  it("strips surrounding quotes from FSQ_API_KEY", async () => {
    // This repo's .env values are written quoted, and FSQ_API_KEY is pasted by
    // hand into the Vercel dashboard. Quotes carried into the Bearer header fail
    // upstream as 401, which reads as a bad key rather than a paste artefact.
    process.env.FSQ_API_KEY = "'quoted_fsq_key'";
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: async () => "{\"results\":[]}",
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq(), res);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer quoted_fsq_key");
  });

  it("forwards the search bar's typeahead params (fields, radius) on place search", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: async () => "{\"results\":[]}",
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(
      makeReq({
        url:
          "/api/fsq/places/search?query=cafe&ll=40,-74&radius=3000&limit=6" +
          "&fields=name%2Clocation",
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://places-api.foursquare.com/places/search?query=cafe&ll=40,-74&radius=3000&limit=6&fields=name%2Clocation",
      expect.any(Object)
    );
  });

  it("still rejects place search with a param outside the typeahead allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq({ url: "/api/fsq/places/search?query=park&ll=40,-74&sort=DISTANCE" }), res);

    expect(res.statusCode).toBe(404);
    expect(res.jsonBody?.error).toBe("Foursquare path is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards allowed place detail requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: async () => "{\"name\":\"Park\"}",
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq({ url: "/api/fsq/places/abc123?fields=name%2Clocation" }), res);

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://places-api.foursquare.com/places/abc123?fields=name%2Clocation",
      expect.any(Object)
    );
  });
});
