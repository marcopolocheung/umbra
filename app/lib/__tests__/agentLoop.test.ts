import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../agent/agentLoop";
import { callModel, rolesShareConfig } from "../agent/llmClient";
import { executeTool } from "../agent/tools";
import type { AgentContext } from "../agent/tools";
import type { LlmPart, LlmResponse } from "../agent/llmClient";

vi.mock("../agent/llmClient", () => ({
  callModel: vi.fn(),
  rolesShareConfig: vi.fn(),
}));

vi.mock("../agent/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/tools")>()),
  executeTool: vi.fn(),
  toolDeclarations: [],
}));

const mockCallModel = vi.mocked(callModel);
const mockRolesShareConfig = vi.mocked(rolesShareConfig);
const mockExecuteTool = vi.mocked(executeTool);

function modelResponse(parts: LlmPart[]): LlmResponse {
  return { candidates: [{ content: { role: "model", parts } }] };
}

function makeCtx(): AgentContext {
  return {
    mapRef: { current: null },
    shadowLayerRef: { current: null },
    dateRef: { current: new Date("2026-08-08T12:00:00Z") },
    setDate: vi.fn(),
    getUtcOffsetMin: () => 0,
    getUserLocation: () => null,
    setWaypointA: vi.fn(),
    setWaypointB: vi.fn(),
    setAdditionalWaypoints: vi.fn(),
    calculateRoute: vi.fn(),
    setPins: vi.fn(),
  };
}

describe("runAgent fallback plotting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRolesShareConfig.mockReturnValue(false);
    mockExecuteTool.mockImplementation(async (name) => {
      if (name === "get_current_context") {
        return { center: { lat: 40.7, lng: -74 }, zoom: 14, locationKnown: true };
      }
      if (name === "search_places") {
        return {
          results: [
            { name: "Bryant Park", lat: 40.7536, lng: -73.9832 },
            { name: "Grace Plaza", lat: 40.752, lng: -73.985 },
          ],
        };
      }
      if (name === "plot_points") {
        return { ok: true, plotted: 2 };
      }
      return { ok: true };
    });
  });

  it("plots gathered place candidates when the model finishes without plot_points", async () => {
    mockCallModel
      .mockResolvedValueOnce(modelResponse([
        { functionCall: { name: "search_places", args: { query: "shadowed parks" } } },
      ]))
      .mockResolvedValueOnce(modelResponse([{ text: "Try Bryant Park around 3 PM." }]))
      .mockResolvedValueOnce(modelResponse([{ text: "Bryant Park is plotted for your walk." }]));

    const toolEvents: string[] = [];
    const result = await runAgent({
      history: [],
      userText: "Plan a shadowed afternoon",
      ctx: makeCtx(),
      onToolEvent: (event) => toolEvents.push(event.name),
    });

    expect(result.text).toBe("Bryant Park is plotted for your walk.");
    expect(toolEvents).toEqual(["search_places", "plot_points"]);
    expect(mockExecuteTool).toHaveBeenCalledWith(
      "plot_points",
      {
        points: [
          { label: "Bryant Park", lat: 40.7536, lng: -73.9832 },
          { label: "Grace Plaza", lat: 40.752, lng: -73.985 },
        ],
      },
      expect.any(Object)
    );
    expect(mockCallModel.mock.calls[2][0].systemInstruction?.parts[0].text)
      .toContain("Map state guarantee");
  });

  it("does not plot a fallback when the model already called plot_points", async () => {
    mockCallModel
      .mockResolvedValueOnce(modelResponse([
        {
          functionCall: {
            name: "plot_points",
            args: { points: [{ lat: 40.7536, lng: -73.9832, label: "Bryant Park" }] },
          },
        },
      ]))
      .mockResolvedValueOnce(modelResponse([{ text: "Pinned Bryant Park." }]));

    await runAgent({
      history: [],
      userText: "Show Bryant Park",
      ctx: makeCtx(),
    });

    const plotCalls = mockExecuteTool.mock.calls.filter(([name]) => name === "plot_points");
    expect(plotCalls).toHaveLength(1);
  });

  it("still plots fallback points on the same-model fast path", async () => {
    mockRolesShareConfig.mockReturnValue(true);
    mockCallModel
      .mockResolvedValueOnce(modelResponse([
        { functionCall: { name: "search_places", args: { query: "shadowed plazas" } } },
      ]))
      .mockResolvedValueOnce(modelResponse([{ text: "Use Bryant Park first." }]));

    const result = await runAgent({
      history: [],
      userText: "Plan a shadowed walk",
      ctx: makeCtx(),
    });

    expect(result.text).toBe("Use Bryant Park first.");
    expect(mockExecuteTool).toHaveBeenCalledWith(
      "plot_points",
      expect.objectContaining({ points: expect.any(Array) }),
      expect.any(Object)
    );
    expect(mockCallModel).toHaveBeenCalledTimes(2);
  });
});
