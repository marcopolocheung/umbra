import { useCallback, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import type { LlmContent } from "../lib/agent/llmClient";
import type { AgentContext, AssistantPin } from "../lib/agent/tools";
import type { IShadowLayer } from "../lib/shadow/IShadowLayer";
import type { RoutePlan, RoutePlanRequest, RoutePlanTerminalResult } from "../lib/routePlanJob";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

interface UseAgentArgs {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  shadowLayerRef: React.MutableRefObject<IShadowLayer | null>;
  dateRef: React.MutableRefObject<Date>;
  setDate: (d: Date) => void;
  mapUtcOffsetMin: number;
  /** The user's known location as [lng, lat], or null. */
  userLocation: [number, number] | null;
  setWaypointA: (coord: [number, number], label: string) => void;
  setWaypointB: (coord: [number, number], label: string) => void;
  setAdditionalWaypoints: (coords: [number, number][]) => void;
  createRoutePlanRequest: (plan: RoutePlan) => RoutePlanRequest;
  submitRoutePlan: (request: RoutePlanRequest) => Promise<RoutePlanTerminalResult>;
  cancelRoutePlan: (requestId: string) => boolean;
  setPins: (pins: AssistantPin[]) => void;
}

const TOOL_LABELS: Record<string, string> = {
  locate_user: "Finding your location",
  geocode_place: "Looking up a place",
  search_places: "Searching for places",
  check_shadow: "Probing real shadow on the map",
  set_time: "Setting the time of day",
  plot_points: "Plotting points on the map",
  plan_shadowed_route: "Computing a shadow-aware route",
};

let idCounter = 0;
const nextId = () => `m${Date.now()}_${idCounter++}`;

export function useAgent(args: UseAgentArgs) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isThinking, setIsThinking] = useState(false);

  // Keep live values in refs so tool executors always see current state.
  const offsetRef = useRef(args.mapUtcOffsetMin);
  offsetRef.current = args.mapUtcOffsetMin;
  const userLocationRef = useRef(args.userLocation);
  userLocationRef.current = args.userLocation;

  const historyRef = useRef<LlmContent[]>([]);
  // Pins outlive a turn, so the next turn's write call has to know what is
  // already on the map.
  const pinsRef = useRef<AssistantPin[]>([]);
  // Geocodes, searches and shadow checks, reused across the session's turns.
  const toolCacheRef = useRef(new Map<string, Record<string, unknown>>());

  // AgentContext is stable across renders; it reads through refs/callbacks.
  const ctxRef = useRef<AgentContext>({
    mapRef: args.mapRef,
    shadowLayerRef: args.shadowLayerRef,
    dateRef: args.dateRef,
    setDate: args.setDate,
    getUtcOffsetMin: () => offsetRef.current,
    getUserLocation: () => userLocationRef.current,
    setWaypointA: args.setWaypointA,
    setWaypointB: args.setWaypointB,
    setAdditionalWaypoints: args.setAdditionalWaypoints,
    createRoutePlanRequest: args.createRoutePlanRequest,
    submitRoutePlan: args.submitRoutePlan,
    cancelRoutePlan: args.cancelRoutePlan,
    setPins: args.setPins,
  });
  // Refresh callback identities (cheap; keeps closures current).
  ctxRef.current.setDate = args.setDate;
  ctxRef.current.setWaypointA = args.setWaypointA;
  ctxRef.current.setWaypointB = args.setWaypointB;
  ctxRef.current.setAdditionalWaypoints = args.setAdditionalWaypoints;
  ctxRef.current.createRoutePlanRequest = args.createRoutePlanRequest;
  ctxRef.current.submitRoutePlan = args.submitRoutePlan;
  ctxRef.current.cancelRoutePlan = args.cancelRoutePlan;
  ctxRef.current.setPins = (pins) => {
    pinsRef.current = pins;
    args.setPins(pins);
  };

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isThinking) return;

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", text: trimmed },
    ]);
    setIsThinking(true);

    try {
      const { runAgent } = await import("../lib/agent/agentLoop");
      const result = await runAgent({
        history: historyRef.current,
        pins: pinsRef.current,
        userText: trimmed,
        ctx: ctxRef.current,
        cache: toolCacheRef.current,
        onToolEvent: (e) => {
          const label = TOOL_LABELS[e.name] ?? e.name;
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: "tool", text: label },
          ]);
        },
      });
      historyRef.current = result.history;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "assistant", text: result.text },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "assistant",
          text:
            err instanceof Error
              ? `Sorry — ${err.message}`
              : "Sorry, something went wrong talking to the assistant.",
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  }, [isThinking]);

  const reset = useCallback(() => {
    historyRef.current = [];
    setMessages([]);
  }, []);

  return { messages, isThinking, sendMessage, reset };
}
