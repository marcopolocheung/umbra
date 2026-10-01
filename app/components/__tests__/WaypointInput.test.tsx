/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WaypointInput from "../WaypointInput";

/**
 * Same provider-policy claim as SearchBar: the route inputs geocode on submit,
 * never from a keystroke. See app/lib/nominatim.ts.
 */
const geocodeForward = vi.fn();
vi.mock("../../lib/nominatim", () => ({
  geocodeForward: (q: string) => geocodeForward(q),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  geocodeForward.mockReset();
  geocodeForward.mockResolvedValue([
    { place_id: 7, display_name: "Prospect Park, Brooklyn", lat: "40.66", lon: "-73.97" },
  ]);
});

function renderInput() {
  const onSet = vi.fn();
  render(
    <WaypointInput
      label={null}
      placeholder="Choose starting point"
      dotColor="green"
      onSet={onSet}
      onClear={vi.fn()}
    />
  );
  return { onSet, input: screen.getByPlaceholderText("Choose starting point") };
}

describe("WaypointInput", () => {
  it("does not geocode while the user types", () => {
    vi.useFakeTimers();
    const { input } = renderInput();

    fireEvent.change(input, { target: { value: "prospect park" } });
    vi.advanceTimersByTime(10_000);

    expect(geocodeForward).not.toHaveBeenCalled();
    expect(screen.getByText("Press Enter to search")).toBeTruthy();
  });

  it("geocodes on Enter and sets the waypoint from the chosen match", async () => {
    const { input, onSet } = renderInput();
    fireEvent.change(input, { target: { value: "prospect park" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const option = await screen.findByText("Prospect Park");
    expect(geocodeForward).toHaveBeenCalledTimes(1);

    fireEvent.click(option);
    expect(onSet).toHaveBeenCalledWith([-73.97, 40.66], "Prospect Park, Brooklyn");
  });

  it("drops a geocode that resolves after the query has moved on", async () => {
    let resolveFirst: (r: unknown[]) => void = () => {};
    geocodeForward.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; })
    );
    const { input, onSet } = renderInput();

    fireEvent.change(input, { target: { value: "prospect park" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // User gives up waiting and retypes before the first geocode comes back.
    fireEvent.change(input, { target: { value: "times square" } });
    resolveFirst([
      { place_id: 7, display_name: "Prospect Park, Brooklyn", lat: "40.66", lon: "-73.97" },
    ]);
    await waitFor(() => expect(geocodeForward).toHaveBeenCalledTimes(1));

    // The abandoned query's top hit must not be showing, nor armed for Enter.
    expect(screen.queryByText("Prospect Park")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSet).not.toHaveBeenCalled();
  });
});

describe("WaypointInput empty answers (R8c)", () => {
  it("reads a no-match answer in the caption tone, not as an error", async () => {
    geocodeForward.mockResolvedValue([]);
    const { input } = renderInput();
    fireEvent.change(input, { target: { value: "zzqx" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const line = await screen.findByText("Nothing matches “zzqx”. Try a street address or a place name.");
    expect(line.className).toContain("text-ink-muted");
    expect(line.className).not.toContain("text-danger");
  });

  it("keeps a failed search in the danger tone", async () => {
    geocodeForward.mockRejectedValue(new Error("offline"));
    const { input } = renderInput();
    fireEvent.change(input, { target: { value: "zzqx" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await screen.findByText("Address search failed. Check your connection.")).className).toContain("text-danger");
  });
});
