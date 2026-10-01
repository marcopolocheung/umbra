/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlaceDetail from "../PlaceDetail";

/**
 * The claim under test is an honesty one: a search result carries only a name,
 * category and address, so the entry must not draw a price, rating, hours or
 * photos it was never given, and must say which facts are missing.
 */
afterEach(cleanup);

const SEARCHED = {
  name: "Mid-Manhattan Library",
  category: "Library",
  address: "455 5th Ave, New York",
  coord: [-73.9817, 40.7526] as [number, number],
};

describe("PlaceDetail", () => {
  it("shows only what the search returned and names the missing facts", () => {
    render(<PlaceDetail place={SEARCHED} onDirections={() => {}} onBack={() => {}} />);

    expect(screen.getByRole("heading", { name: "Mid-Manhattan Library" })).toBeTruthy();
    expect(screen.getByText("Library")).toBeTruthy();
    expect(screen.getByText("455 5th Ave, New York")).toBeTruthy();
    expect(screen.getByText(/Not listed: hours, phone, website\./)).toBeTruthy();
    // The old fallbacks: an invented price, placeholder photos, a rating row.
    expect(screen.queryByText("$$")).toBeNull();
    expect(screen.queryByText("Photo")).toBeNull();
    expect(screen.queryByText("Rating")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws a line for each fact the provider did give", () => {
    render(
      <PlaceDetail
        place={{ ...SEARCHED, hours: "Open until 8 PM", phone: "212 555 0100", website: "https://example.org", rating: 9.1, priceLevel: "$" }}
        onDirections={() => {}}
        onBack={() => {}}
      />,
    );

    expect(screen.getByText("Open until 8 PM")).toBeTruthy();
    expect(screen.getByRole("link", { name: "212 555 0100" }).getAttribute("href")).toBe("tel:212 555 0100");
    expect(screen.getByRole("link", { name: "https://example.org" })).toBeTruthy();
    expect(screen.getByText("9.1/10")).toBeTruthy();
    expect(screen.getByText("$")).toBeTruthy();
    expect(screen.queryByText(/Not listed/)).toBeNull();
  });

  it("says the address is missing rather than inventing one", () => {
    render(<PlaceDetail place={{ ...SEARCHED, address: null, category: null }} onDirections={() => {}} onBack={() => {}} />);

    expect(screen.getByText("Not in the search result")).toBeTruthy();
    expect(screen.getByText("Place")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("wires Directions and Back", () => {
    const onDirections = vi.fn();
    const onBack = vi.fn();
    render(<PlaceDetail place={SEARCHED} onDirections={onDirections} onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: "Directions" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onDirections).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
