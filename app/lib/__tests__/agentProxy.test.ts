import { beforeEach, describe, expect, it, vi } from "vitest";

type JsonBody = Record<string, unknown>;

function makePayload(model = "gemini-3.1-flash-lite") {
  return {
    model,
    messages: [{ role: "user", content: "plan shadow" }],
  };
}

function makeReq({
  method = "POST",
  body = { provider: "gemini", payload: makePayload() },
  headers = {},
  ip = "203.0.113.10",
}: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
} = {}) {
  return {
    method,
    body,
    headers: { origin: "https://shademapnav.vercel.app", "x-forwarded-for": ip, ...headers },
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
  const mod = await import("../../../api/agent.js");
  return mod.default as (req: ReturnType<typeof makeReq>, res: ReturnType<typeof makeRes>) => Promise<void>;
}

describe("api/agent proxy hardening", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    process.env.GEMINI_API_KEY = "key_one";
    process.env.AGENT_RATE_LIMIT_PER_MIN = "20";
    delete process.env.GEMINI_ALLOWED_MODELS;
    delete process.env.AGENT_ALLOWED_ORIGINS;
    delete process.env.AGENT_MAX_PAYLOAD_BYTES;
  });

  it("rejects disallowed models before forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(
      makeReq({ body: { provider: "gemini", payload: makePayload("not-a-real-model") } }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody?.error).toBe("model is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects browser origins outside the allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(
      makeReq({ headers: { origin: "https://example.invalid" } }),
      res
    );

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody?.error).toBe("Origin not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests that name no origin or referer", async () => {
    // A browser always sends Origin on a POST; a bare script does not.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();
    const req = makeReq();
    delete (req.headers as Record<string, string>).origin;

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.jsonBody?.error).toBe("Origin not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limits repeated requests from one IP", async () => {
    process.env.AGENT_RATE_LIMIT_PER_MIN = "1";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 200,
      text: async () => "{\"ok\":true}",
    }));
    const handler = await loadHandler();

    const first = makeRes();
    await handler(makeReq({ ip: "203.0.113.20" }), first);
    expect(first.statusCode).toBe(200);

    const second = makeRes();
    await handler(makeReq({ ip: "203.0.113.20" }), second);
    expect(second.statusCode).toBe(429);
    expect(second.jsonBody?.error).toMatch(/Too many agent requests/);
  });

  it("forwards valid Gemini payloads with a server key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => "{\"choices\":[]}",
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq({ headers: { origin: "https://shademapnav.vercel.app" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.sentBody).toBe("{\"choices\":[]}");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer key_one" }),
        body: JSON.stringify(makePayload()),
      })
    );
  });

  it("fails over past a dead key to the next one in the pool", async () => {
    process.env.GEMINI_API_KEY = "dead_key,live_key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 403, text: async () => "{\"error\":{}}" })
      .mockResolvedValueOnce({ status: 200, text: async () => "{\"choices\":[]}" });
    vi.stubGlobal("fetch", fetchMock);
    const handler = await loadHandler();
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
      "Bearer dead_key",
      "Bearer live_key",
    ]);
  });
});
