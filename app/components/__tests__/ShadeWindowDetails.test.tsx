// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import ShadeWindowDetails from "../ShadeWindowDetails";
import AssistantPanel from "../AssistantPanel";
import { shadePayload } from "../../lib/agent/__tests__/shadeFixture";
import {
  verifyAnswer,
  type ShadeWindowClaimReceipt,
  type ToolResultEnvelope,
} from "../../lib/agent/receipts";
import { shadeWindowObjectId } from "../../lib/agent/shadeWindows";

afterEach(cleanup);
function answer(mode: "shade" | "sun" = "shade", long = false) {
  const p = shadePayload({ mode, fromMinutes: long ? 855 : 847, toMinutes: long ? 1080 : 963 });
  const s = p.results[0];
  const e: ToolResultEnvelope = {
    resultId: "window",
    toolName: "find_shade_spots",
    producedAt: "2026-07-04T18:00:00Z",
    sourceVersion: p.generation,
    provenance: { category: "application_state", bounded: true },
    fieldProvenance: {},
    payload: p,
  };
  return verifyAnswer(
    {
      receipts: [
        {
          kind: "shade_window",
          candidateId: s.candidateId,
          requestedDate: p.requestedDate,
          requestedWindow: p.requestedWindow,
          value: { meanShade: s.meanShade },
          supportingResultIds: [e.resultId],
        },
      ],
    },
    {
      evidence: [e],
      mapObjects: [
        {
          id: shadeWindowObjectId(e.resultId, s.candidateId),
          kind: "shade_window",
          lat: s.lat,
          lng: s.lng,
        },
      ],
      currentPlanRevision: 1,
      now: e.producedAt,
    },
  );
}
describe("canonical shade-window UI", () => {
  it("discloses the typical day and snapped request, with quarter-hour rows", () => {
    const a = answer();
    render(<ShadeWindowDetails receipt={a.receipts[0] as ShadeWindowClaimReceipt} />);
    expect(screen.getByText(/2026-07-15/)).toBeTruthy();
    expect(screen.getByText(/2:07 PM–4:03 PM/)).toBeTruthy();
    fireEvent.click(screen.getByText("Shade by time"));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(9);
    expect(screen.getByText("2:00 PM–2:15 PM")).toBeTruthy();
  });
  it("aggregates long intervals and derives sun percentages from exact shade", () => {
    const a = answer("sun", true);
    render(<ShadeWindowDetails receipt={a.receipts[0] as ShadeWindowClaimReceipt} />);
    fireEvent.click(screen.getByText("Sun by time"));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(5);
    expect(screen.getByText("2:15 PM–3:00 PM")).toBeTruthy();
    expect(screen.getAllByText("80%")).toHaveLength(4);
  });
  it("never displays rejected observations", () => {
    const a = answer(),
      r = a.receipts[0] as ShadeWindowClaimReceipt;
    const { container } = render(
      <ShadeWindowDetails receipt={{ ...r, verification: "rejected" }} />,
    );
    expect(container.textContent).toBe("");
  });
  it("allows focus on the exact registered sidewalk and renders unavailable messages", () => {
    const a = answer(),
      focus = vi.fn();
    const props = {
      open: true,
      onClose: vi.fn(),
      isThinking: false,
      onSend: vi.fn(),
      onReset: vi.fn(),
      onFocusMapObject: focus,
      stopIds: [],
    };
    render(
      <AssistantPanel
        {...props}
        messages={[{ id: "1", role: "assistant", text: "", answer: a }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /92% modelled shade/ }));
    expect(focus).toHaveBeenCalledWith((a.receipts[0] as ShadeWindowClaimReceipt).mapObjectId);
    cleanup();
    render(
      <AssistantPanel
        {...props}
        messages={[
          {
            id: "2",
            role: "assistant",
            text: "",
            answer: {
              ...a,
              receipts: [],
              blocks: [{ kind: "unknown", claimKind: "shade_window", reason: "outside_coverage" }],
            },
          },
        ]}
      />,
    );
    expect(screen.getByText("No shade-table data is available for this area.")).toBeTruthy();
  });
});
