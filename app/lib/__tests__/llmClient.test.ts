import { afterEach, describe, expect, it, vi } from "vitest";
import { callModel, type LlmContent } from "../agent/llmClient";

const SIGNATURE = { google: { thought_signature: "sig-abc" } };

function reply(message: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message, finish_reason: "stop" }] }),
    clone() {
      return this;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("llmClient against Gemini", () => {
  it("hands a tool call's thought signature back on the next request, and never sends seed", async () => {
    vi.stubEnv("VITE_GEMINI_API_KEY", "k1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "g1",
              type: "function",
              function: { name: "check_shadow", arguments: '{"lat":1,"lng":2}' },
              extra_content: SIGNATURE,
            },
          ],
        })
      )
      .mockResolvedValueOnce(reply({ role: "assistant", content: "Shaded." }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await callModel({ contents: [{ role: "user", parts: [{ text: "shade?" }] }] });
    const call = first.candidates![0].content;
    const history: LlmContent[] = [
      { role: "user", parts: [{ text: "shade?" }] },
      call,
      { role: "user", parts: [{ functionResponse: { name: "check_shadow", response: { shadowFraction: 0.7 } } }] },
    ];
    await callModel({ contents: history });

    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    const assistant = sent.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.tool_calls[0].extra_content).toEqual(SIGNATURE);
    expect(sent).not.toHaveProperty("seed");
    expect(fetchMock.mock.calls[1][0]).toBe("/__gemini/v1beta/openai/chat/completions");
  });

  it("unquotes numeric coordinates Gemini sends as strings, leaving other strings alone", async () => {
    vi.stubEnv("VITE_GEMINI_API_KEY", "k1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        reply({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "g1",
              type: "function",
              function: {
                name: "check_shadow",
                arguments:
                  '{"lat":"40.7359","lng":"-73.9911","radiusM":"400","time":"3:00 PM","points":[{"lat":"1.5","lng":"x"}]}',
              },
            },
          ],
        }),
      ),
    );
    const res = await callModel({ contents: [{ role: "user", parts: [{ text: "shade?" }] }] });
    expect(res.candidates![0].content.parts[0].functionCall!.args).toEqual({
      lat: 40.7359,
      lng: -73.9911,
      radiusM: 400,
      time: "3:00 PM",
      points: [{ lat: 1.5, lng: "x" }],
    });
  });

  it("unquotes coordinates in a tool call the model wrote as text", async () => {
    vi.stubEnv("VITE_GEMINI_API_KEY", "k1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        reply({
          role: "assistant",
          content: '<tool_call>{"name":"check_shadow","arguments":{"lat":"40.7359","lng":"-73.9911"}}</tool_call>',
        }),
      ),
    );
    const res = await callModel({ contents: [{ role: "user", parts: [{ text: "shade?" }] }] });
    expect(res.candidates![0].content.parts[0].functionCall).toEqual({
      name: "check_shadow",
      args: { lat: 40.7359, lng: -73.9911 },
    });
  });

  it("moves past a key Gemini rejects to the next key in the pool", async () => {
    vi.stubEnv("VITE_GEMINI_API_KEY", "dead,live");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ...reply({}), ok: false, status: 403 })
      .mockResolvedValueOnce(reply({ role: "assistant", content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await callModel({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });

    expect(res.candidates![0].content.parts[0].text).toBe("ok");
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
      "Bearer dead",
      "Bearer live",
    ]);
  });

  it("waits out a 503 overload and retries rather than failing the turn", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_GEMINI_API_KEY", "k1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ...reply({}), ok: false, status: 503 })
      .mockResolvedValueOnce(reply({ role: "assistant", content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = callModel({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.candidates![0].content.parts[0].text).toBe("ok");
  });
});
