// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "../SettingsPanel";

afterEach(cleanup);

function renderPanel(showSheds: boolean, onShowShedsChange = vi.fn()) {
  render(
    <SettingsPanel
      showSunLines={false}
      onShowSunLinesChange={vi.fn()}
      showSheds={showSheds}
      onShowShedsChange={onShowShedsChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  return onShowShedsChange;
}

describe("SettingsPanel sidewalk sheds", () => {
  it("reports the toggle to its owner", () => {
    const onChange = renderPanel(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /sidewalk sheds/i }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("explains the layer only while it is on, including that its shade is not painted", () => {
    renderPanel(false);
    expect(screen.queryByText(/not painted on the map/i)).toBeNull();
    cleanup();
    renderPanel(true);
    expect(screen.getByText(/not painted on the map/i)).toBeTruthy();
  });
});
