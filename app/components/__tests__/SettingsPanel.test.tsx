// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NavigationSignatureType } from "../../lib/navigationData/shardContract";
import SettingsPanel from "../SettingsPanel";

afterEach(cleanup);

function renderPanel(showSheds: boolean, onShowShedsChange = vi.fn(), onThemeChange = vi.fn()) {
  render(
    <SettingsPanel
      themePreference="auto"
      onThemePreferenceChange={onThemeChange}
      showSunLines={false}
      onShowSunLinesChange={vi.fn()}
      showSheds={showSheds}
      onShowShedsChange={onShowShedsChange}
      showStreetTypes={false}
      onShowStreetTypesChange={vi.fn()}
      streetTypes={null}
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

describe("SettingsPanel theme", () => {
  it("marks the current preference and reports a new one", () => {
    const onThemeChange = vi.fn();
    renderPanel(false, vi.fn(), onThemeChange);
    const group = screen.getByRole("group", { name: "Theme" });
    const auto = within(group).getByRole("button", { name: "Auto" });
    expect(auto.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Night" }));
    expect(onThemeChange).toHaveBeenCalledWith("night");
  });

  it("states that the override leaves the map alone", () => {
    renderPanel(false);
    expect(screen.getByText(/panels only, not the map/i)).toBeTruthy();
  });
});

describe("SettingsPanel street shade types", () => {
  const model = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../server/navigation-prep/models/signatures-v1.json"), "utf8"),
  ) as { types: NavigationSignatureType[] };

  function renderTypes(showStreetTypes: boolean, streetTypes: NavigationSignatureType[] | null) {
    const onChange = vi.fn();
    render(
      <SettingsPanel
        themePreference="auto"
        onThemePreferenceChange={vi.fn()}
        showSunLines={false}
        onShowSunLinesChange={vi.fn()}
        showSheds={false}
        onShowShedsChange={vi.fn()}
        showStreetTypes={showStreetTypes}
        onShowStreetTypesChange={onChange}
        streetTypes={streetTypes}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    return onChange;
  }

  it("reports the toggle to its owner", () => {
    const onChange = renderTypes(false, null);
    fireEvent.click(screen.getByRole("checkbox", { name: /street shade types/i }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("asks for a route until the types are loaded", () => {
    renderTypes(true, null);
    expect(screen.getByText(/calculate a walking route/i)).toBeTruthy();
  });

  it("lists every frozen type, with its hours, under its group", () => {
    renderTypes(true, model.types);
    for (const type of model.types) expect(screen.getByText(type.name)).toBeTruthy();
    // The canyon type (6) is shaded at both ends of a summer day, not sunny at noon.
    const partly = screen.getByText("Partly shaded").parentElement!;
    expect(within(partly).getByText(model.types[6].name)).toBeTruthy();
    const sunny = screen.getByText("Sunny all day").parentElement!;
    expect(within(sunny).getByText(model.types[0].name)).toBeTruthy();
    expect(within(sunny).queryByText(model.types[1].name)).toBeNull();
  });
});

