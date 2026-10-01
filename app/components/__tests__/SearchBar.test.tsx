/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SearchBar, { nominatimCategory } from "../SearchBar";

/**
 * The claim under test is a provider-policy one, not a rendering one: the OSMF
 * Nominatim usage policy lists autocomplete under unacceptable use, so typing
 * must never produce a geocode. Only an explicit submit may.
 *
 * There is no `setupFiles` in vitest.config.ts, so unmounting is this file's job.
 */
const geocodeForward = vi.fn();
vi.mock("../../lib/nominatim", () => ({
  geocodeForward: (q: string) => geocodeForward(q),
}));

const suggestPlaces = vi.fn();
vi.mock("../../services/foursquare", () => ({
  suggestPlaces: (...a: unknown[]) => suggestPlaces(...a),
}));

const SUGGESTION = {
  name: "Brooklyn Roasting",
  category: "Coffee Shop",
  hours: "Open until 6 PM",
  rating: 8.7,
  photo: null as string | null,
  address: "25 Jay St, Brooklyn",
  lat: 40.702,
  lng: -73.989,
  distanceM: 420,
};

const RESULT = {
  place_id: 1,
  display_name: "Brooklyn Bridge, New York, United States",
  lat: "40.7061",
  lon: "-73.9969",
  boundingbox: ["40.70", "40.71", "-74.00", "-73.99"] as [string, string, string, string],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  // jsdom has no layout, so the highlight effect's scrollIntoView is absent.
  Element.prototype.scrollIntoView = vi.fn();
  geocodeForward.mockReset();
  geocodeForward.mockResolvedValue([RESULT]);
  suggestPlaces.mockReset();
  suggestPlaces.mockResolvedValue([]);
  localStorage.clear();
});

function renderBar() {
  const onSelect = vi.fn();
  render(<SearchBar onSelect={onSelect} />);
  return { onSelect, input: screen.getByRole("combobox") };
}

describe("SearchBar", () => {
  it("does not geocode while the user types, however long they pause", () => {
    vi.useFakeTimers();
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    vi.advanceTimersByTime(10_000);

    expect(geocodeForward).not.toHaveBeenCalled();
  });

  it("geocodes once on Enter and offers the matches", async () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Brooklyn Bridge");
    expect(geocodeForward).toHaveBeenCalledTimes(1);
    expect(geocodeForward).toHaveBeenCalledWith("brooklyn bridge");
  });

  it("selects the highlighted match on a second Enter, centred on its bbox", async () => {
    const { input, onSelect } = renderBar();
    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("option");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      name: "Brooklyn Bridge",
      center: [-73.995, 40.705],
    });
  });

  it("geocodes when the magnifier is clicked", async () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "brooklyn bridge" } });

    fireEvent.click(screen.getByLabelText("Search"));

    await waitFor(() => expect(geocodeForward).toHaveBeenCalledTimes(1));
  });

  it("drops a geocode that resolves after the query has moved on", async () => {
    let resolveFirst: (r: unknown[]) => void = () => {};
    geocodeForward.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; })
    );
    const { input, onSelect } = renderBar();

    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // User gives up waiting and retypes before the first geocode comes back.
    fireEvent.change(input, { target: { value: "times square" } });
    resolveFirst([RESULT]);
    await waitFor(() => expect(geocodeForward).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("option")).toBeNull();
    // The stale top hit must not be armed for the next Enter.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("centres on the point when Nominatim returns no bounding box", async () => {
    geocodeForward.mockResolvedValue([{ ...RESULT, boundingbox: undefined }]);
    const { input, onSelect } = renderBar();
    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("option");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect.mock.calls[0][0]).toMatchObject({ center: [-73.9969, 40.7061], zoom: 16 });
  });
});

describe("SearchBar Foursquare typeahead", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    geocodeForward.mockReset();
    geocodeForward.mockResolvedValue([RESULT]);
    suggestPlaces.mockReset();
    suggestPlaces.mockResolvedValue([]);
    localStorage.clear();
  });

  function renderBarWithCenter() {
    const onSelect = vi.fn();
    // mapCenter is [lat, lng] — the hook's convention (useShadowTime).
    render(<SearchBar onSelect={onSelect} mapCenter={[40.702, -73.989]} />);
    return { onSelect, input: screen.getByRole("combobox") };
  }

  it("suggests via Foursquare from a keystroke, debounced, anchored to the map center", async () => {
    vi.useFakeTimers();
    suggestPlaces.mockResolvedValue([SUGGESTION]);
    const { input } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "brook" } });
    expect(suggestPlaces).not.toHaveBeenCalled(); // debounce holds
    vi.advanceTimersByTime(400);

    await vi.waitFor(() => expect(suggestPlaces).toHaveBeenCalledTimes(1));
    // suggestPlaces takes the anchor as [lng, lat] — the swap is the test's
    // real claim, after the U6 grounding audit caught a swapped anchor.
    expect(suggestPlaces).toHaveBeenCalledWith(
      "brook",
      [-73.989, 40.702],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    // The policy claim: typing still never touches Nominatim.
    expect(geocodeForward).not.toHaveBeenCalled();
  });

  it("does not suggest below two characters or without a map anchor", () => {
    vi.useFakeTimers();
    const { input } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "b" } });
    vi.advanceTimersByTime(10_000);
    expect(suggestPlaces).not.toHaveBeenCalled();
  });

  it("shows a rich row (category, hours, rating, distance) and selects it on Enter", async () => {
    vi.useFakeTimers();
    suggestPlaces.mockResolvedValue([SUGGESTION]);
    const { input, onSelect } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "brook" } });
    await vi.advanceTimersByTimeAsync(400);
    await act(async () => {}); // flush the suggestion state update
    const option = screen.getByRole("option");
    expect(option.textContent).toContain("Brooklyn Roasting");
    expect(option.textContent).toContain("Coffee Shop");
    expect(option.textContent).toContain("Open until 6 PM");
    expect(option.textContent).toContain("8.7");
    expect(option.textContent).toContain("420 m");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      name: "Brooklyn Roasting",
      category: "Coffee Shop",
      address: "25 Jay St, Brooklyn",
      center: [-73.989, 40.702],
      zoom: 16,
    });
    expect(geocodeForward).not.toHaveBeenCalled();
  });

  it("submits to Nominatim on Enter when no suggestion is highlighted", async () => {
    vi.useFakeTimers();
    suggestPlaces.mockResolvedValue([]);
    const { input } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    vi.advanceTimersByTime(400);
    await vi.waitFor(() => expect(suggestPlaces).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(geocodeForward).toHaveBeenCalledTimes(1));
    expect(geocodeForward).toHaveBeenCalledWith("brooklyn bridge");
  });

  it("races both providers on submit and interleaves the results by distance", async () => {
    // Nominatim answers with a far address; Foursquare with a near POI — the
    // merged list must read as one distance-ranked ranking, POI first.
    geocodeForward.mockResolvedValue([
      { ...RESULT, display_name: "Far Library, New York", lat: "40.75", lon: "-73.99" },
    ]);
    suggestPlaces.mockResolvedValue([SUGGESTION]);
    const { input } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "library" } });
    await vi.waitFor(() => expect(suggestPlaces).toHaveBeenCalledTimes(1));
    // The magnifier always submits; Enter with suggestions open takes the
    // highlighted suggestion instead.
    fireEvent.click(screen.getByLabelText("Search"));
    await vi.waitFor(() => expect(geocodeForward).toHaveBeenCalledTimes(1));

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain("Brooklyn Roasting");
    expect(options[1].textContent).toContain("Far Library");
  });

  it("labels the listing and says what its distances are measured from", async () => {
    suggestPlaces.mockResolvedValue([SUGGESTION]);
    const { input } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "library" } });
    expect(await screen.findByRole("listbox", { name: /Places nearby/ })).toBeTruthy();
    expect(screen.getByText("from map center")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Search"));
    expect(await screen.findByRole("listbox", { name: /Directory/ })).toBeTruthy();
  });

  it("measures a Nominatim row from the map center and ranks it by that distance", async () => {
    // ~167 m north of the map center: nearer than the 420 m POI. With the
    // center passed as [lat, lng] it read ~15,000 km and sank to the bottom.
    geocodeForward.mockResolvedValue([
      { ...RESULT, display_name: "Near Library, Brooklyn", lat: "40.7035", lon: "-73.989", class: "amenity", type: "library" },
    ]);
    suggestPlaces.mockResolvedValue([SUGGESTION]);
    const { input } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "library" } });
    await vi.waitFor(() => expect(suggestPlaces).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText("Search"));

    const options = await screen.findAllByRole("option", { name: /Near Library|Brooklyn Roasting/ });
    expect(options[0].textContent).toContain("Near Library");
    expect(options[0].textContent).toContain("167 m");
    expect(options[0].textContent).toContain("Library");
    expect(options[1].textContent).toContain("Brooklyn Roasting");
  });

  it("drops a Foursquare duplicate of a Nominatim result instead of listing it twice", async () => {
    suggestPlaces.mockResolvedValue([
      { ...SUGGESTION, name: "Brooklyn Bridge", lat: 40.7061, lng: -73.9969 },
    ]);
    const { input } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    await vi.waitFor(() => expect(suggestPlaces).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText("Search"));
    await vi.waitFor(() => expect(geocodeForward).toHaveBeenCalledTimes(1));

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Brooklyn Bridge");
  });

  it("still shows the Foursquare rows when the Nominatim submit fails", async () => {
    geocodeForward.mockRejectedValue(new Error("nominatim down"));
    suggestPlaces.mockResolvedValue([SUGGESTION]);
    const { input } = renderBarWithCenter();

    fireEvent.change(input, { target: { value: "library" } });
    await vi.waitFor(() => expect(suggestPlaces).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input, { key: "Enter" });

    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Brooklyn Roasting");
  });
});

describe("nominatimCategory", () => {
  it("names the kind of place from the OSM tag, not from display_name", () => {
    expect(nominatimCategory({ class: "amenity", type: "library" })).toBe("Library");
    expect(nominatimCategory({ class: "tourism", type: "theme_park" })).toBe("Theme park");
    expect(nominatimCategory({ class: "highway", type: "residential" })).toBe("Street");
    expect(nominatimCategory({ class: "place", type: "house" })).toBe("Address");
    expect(nominatimCategory({ class: "building", type: "yes" })).toBe("Building");
  });

  it("says nothing when the result carries no tag", () => {
    expect(nominatimCategory({})).toBeNull();
  });
});

describe("SearchBar empty directory (R8c)", () => {
  it("says nothing came back for a submit with no match, and clears on the next keystroke", async () => {
    geocodeForward.mockResolvedValue([]);
    const { input } = renderBar();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzqx" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The status region is always mounted, so the text is what a screen reader hears.
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toContain("Nothing came back for “zzqx”"));
    expect(screen.getByText("Not in the guidebook").className).toContain("umbra-kicker");
    // No map center, so only the address search ran, and the copy says only that.
    expect(status.textContent).toContain("The address search returned no match, or could not be reached.");

    fireEvent.change(input, { target: { value: "zzqxy" } });
    expect(status.textContent).toBe("");
    expect(screen.queryByText("Not in the guidebook")).toBeNull();
  });

  it("names both providers when the map center let nearby places run", async () => {
    geocodeForward.mockResolvedValue([]);
    render(<SearchBar onSelect={vi.fn()} mapCenter={[40.75, -73.98]} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzqx" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Neither the address search nor nearby places returned a match"),
    );
  });

  it("drops an empty answer that lands after Escape", async () => {
    let resolve: (v: unknown[]) => void = () => {};
    geocodeForward.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "zzqx" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });

    await act(async () => { resolve([]); });
    expect(screen.queryByText("Not in the guidebook")).toBeNull();
  });

  it("drops an answer that lands after the search is cleared", async () => {
    let resolve: (v: unknown[]) => void = () => {};
    geocodeForward.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { input } = renderBar();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByLabelText("Clear search"));

    await act(async () => { resolve([RESULT]); });
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("hides a late empty answer after an outside tap, but still opens late matches", async () => {
    let resolve: (v: unknown[]) => void = () => {};
    geocodeForward.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { input } = renderBar();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzqx" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.mouseDown(document.body);
    await act(async () => { resolve([]); });
    expect(screen.queryByText("Not in the guidebook")).toBeNull();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.mouseDown(document.body);
    await act(async () => { resolve([RESULT]); });
    expect(screen.getByRole("option").textContent).toContain("Brooklyn Bridge");
  });

  it("shows no empty state when a submit finds matches", async () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "brooklyn bridge" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByRole("option");
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
