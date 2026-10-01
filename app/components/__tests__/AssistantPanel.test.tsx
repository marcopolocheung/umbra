// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AssistantPanel from "../AssistantPanel";
import type { ChatMessage } from "../../hooks/useAgent";

describe("AssistantPanel C5 receipts", () => {
  it("focuses the receipt's opaque map object without moving panel keyboard focus", () => {
    const focus = vi.fn();
    render(
      <AssistantPanel
        open
        onClose={vi.fn()}
        isThinking={false}
        onSend={vi.fn()}
        onReset={vi.fn()}
        onFocusMapObject={focus}
        stopIds={["assistant-pin:40.70000:-73.90000", "assistant-pin:40.75360:-73.98320"]}
        messages={[
          {
            id: "assistant-1",
            role: "assistant",
            text: "ignored",
            answer: {
              blocks: [{ kind: "claim", claimId: "place-1" }],
              rejectedProseCount: 0,
              danglingClaimBlocks: 0,
              duplicateClaimProposals: 0,
              receipts: [
                {
                  claimId: "place-1",
                  kind: "place",
                  subject: "Bryant Park",
                  value: { lat: 40.7536, lng: -73.9832 },
                  mapObjectId: "assistant-pin:40.75360:-73.98320",
                  supportingResultIds: ["result-1"],
                  observedAt: "2026-08-08T18:00:00.000Z",
                  confidence: "unknown",
                  verification: "verified",
                },
              ],
            },
          },
        ]}
      />,
    );
    const control = screen.getByRole("button", { name: /focus stop 2 on map: bryant park — located/i });
    expect(control.textContent).toBe("2");
    control.focus();
    fireEvent.click(control);
    expect(focus).toHaveBeenCalledWith("assistant-pin:40.75360:-73.98320");
    expect(document.activeElement).toBe(control);
  });

  it("passes the exact route receipt identity to the map owner", () => {
    const focus = vi.fn();
    render(
      <AssistantPanel
        open
        onClose={vi.fn()}
        isThinking={false}
        onSend={vi.fn()}
        onReset={vi.fn()}
        onFocusMapObject={focus}
        stopIds={[]}
        messages={[
          {
            id: "assistant-route",
            role: "assistant",
            text: "ignored",
            answer: {
              blocks: [{ kind: "claim", claimId: "route-claim" }],
              rejectedProseCount: 0,
              danglingClaimBlocks: 0,
              duplicateClaimProposals: 0,
              receipts: [
                {
                  claimId: "route-claim",
                  kind: "route",
                  subject: "route",
                  value: { status: "completed" },
                  requestId: "request-b",
                  actionId: "action-b",
                  planRevision: 7,
                  mapObjectId: "route:request-b:action-b:7",
                  supportingResultIds: ["result-route-b"],
                  observedAt: "2026-08-08T18:00:00.000Z",
                  confidence: "unknown",
                  verification: "verified",
                },
              ],
            },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Route completed — plan revision 7/i }));
    expect(focus).toHaveBeenCalledWith("route:request-b:action-b:7");
  });

  it("renumbers with map order and drops the number when its pin leaves the map", () => {
    const focus = vi.fn();
    const id = "assistant-pin:40.75360:-73.98320";
    const messages: ChatMessage[] = [{
      id: "assistant-stop", role: "assistant", text: "ignored",
      answer: {
        blocks: [{ kind: "claim", claimId: "place-1" }],
        rejectedProseCount: 0, danglingClaimBlocks: 0, duplicateClaimProposals: 0,
        receipts: [{
          claimId: "place-1", kind: "place", subject: "Bryant Park",
          value: { lat: 40.7536, lng: -73.9832 }, mapObjectId: id,
          supportingResultIds: ["result-1"], observedAt: "2026-08-08T18:00:00.000Z",
          confidence: "unknown", verification: "verified",
        }],
      },
    }];
    const panel = (stopIds: string[]) => <AssistantPanel
      open onClose={vi.fn()} messages={messages} isThinking={false}
      onSend={vi.fn()} onReset={vi.fn()} onFocusMapObject={focus} stopIds={stopIds}
    />;
    const { container, rerender } = render(panel([id, "other"]));
    const panelScreen = within(container);
    expect(panelScreen.getByRole("button", { name: /Focus stop 1 on map/ }).textContent).toBe("1");
    rerender(panel(["other", id]));
    expect(panelScreen.getByRole("button", { name: /Focus stop 2 on map/ }).textContent).toBe("2");
    rerender(panel(["other"]));
    expect(panelScreen.queryByRole("button", { name: /Focus stop/ })).toBeNull();
    expect(panelScreen.queryByRole("button", { name: /Bryant Park — located/ })).toBeNull();
    expect(panelScreen.getByText("Bryant Park — located")).toBeTruthy();
  });
});
