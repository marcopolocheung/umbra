/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlaceDetail from "../PlaceDetail";

/**
 * The claim under test is an honesty one: a selected place arrives with only a
 * name, category and address (page.tsx handleSearchSelect), so the entry must
 * not draw a price, rating, hours or photos it was never given, and must say
 * which facts are missing. The fuller fixture below is not reachable from the
 * app today; it pins how each line renders once those facts are passed on.
 */
afterEach(cleanup);

const SEARCHED = {
  name: "Mid-Manhattan Library",
  category: "Library",
  address: "455 5th Ave, New York",
  coord: [-73.9817, 40.7526] as [number, number],
};

describe("PlaceDetail", () => {
  it("shows only the facts it was given and names the missing ones", () => {
    render(<PlaceDetail place={SEARCHED} onDirections={() => {}} onBack={() => {}} />);

    expect(screen.getByRole("heading", { name: "Mid-Manhattan Library" })).toBeTruthy();
    expect(screen.getByText("Library")).toBeTruthy();
    expect(screen.getByText("455 5th Ave, New York")).toBeTruthy();
    expect(screen.getByText(/Not shown here: hours, phone, website\./)).toBeTruthy();
    // The old fallbacks: an invented price, placeholder photos, a rating row.
    expect(screen.queryByText("$$")).toBeNull();
    expect(screen.queryByText("Photo")).toBeNull();
    for (const term of ["Hours", "Phone", "Website", "Rating", "Price"]) expect(screen.queryByText(term)).toBeNull();
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
    expect(screen.getByRole("link", { name: "212 555 0100" }).getAttribute("href")).toBe("tel:2125550100");
    expect(screen.getByRole("link", { name: "https://example.org" })).toBeTruthy();
    expect(screen.getByText("9.1/10")).toBeTruthy();
    expect(screen.getByText("$")).toBeTruthy();
    expect(screen.queryByText(/Not shown here/)).toBeNull();
  });

  it("says the address is missing rather than inventing one", () => {
    render(<PlaceDetail place={{ ...SEARCHED, address: null, category: null }} onDirections={() => {}} onBack={() => {}} />);

    expect(screen.getByText("No address on file")).toBeTruthy();
    expect(screen.getByText("Place")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
  });

  it("says whether the address was copied", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PlaceDetail place={SEARCHED} onDirections={() => {}} onBack={() => {}} />);
    const copy = screen.getByRole("button", { name: "Copy address" });

    fireEvent.click(copy);
    await waitFor(() => expect(copy.textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith("455 5th Ave, New York");
    fireEvent.click(copy);
    await waitFor(() => expect(copy.textContent).toBe("Copy failed"));
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
