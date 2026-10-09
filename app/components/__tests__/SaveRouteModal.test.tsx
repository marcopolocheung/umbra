/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SaveRouteModal from "../SaveRouteModal";

/**
 * Saved routes carry their full geometry in localStorage, so a heavy user
 * fills the ~5 MB quota. `setItem` then throws; the save must say so rather
 * than leave the dialog sitting there as if nothing were pressed.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const quotaError = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");

describe("SaveRouteModal when storage refuses the write", () => {
  it("keeps the dialog open and says why the route was not saved", () => {
    const onSave = vi.fn(() => {
      throw quotaError();
    });
    render(<SaveRouteModal defaultName="Shortest" onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("Shortest", null);
    expect(screen.getByRole("alert").textContent).toMatch(/storage is full/);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("reports a folder that could not be created instead of throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw quotaError();
    });
    render(<SaveRouteModal defaultName="Shortest" onSave={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "+ New folder" }));
    fireEvent.change(screen.getByPlaceholderText("Folder name"), { target: { value: "Summer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByRole("alert").textContent).toMatch(/storage is full/);
    expect(screen.queryByRole("option", { name: "Summer" })).toBeNull();
  });

  it("clears the warning once a later write succeeds", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw quotaError();
    });
    render(<SaveRouteModal defaultName="Shortest" onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "+ New folder" }));
    fireEvent.change(screen.getByPlaceholderText("Folder name"), { target: { value: "Summer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toBeTruthy();

    setItem.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("option", { name: "Summer" })).toBeTruthy();
  });
});
