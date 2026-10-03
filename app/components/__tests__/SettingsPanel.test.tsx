// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE } from "../../lib/heat/profile";
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
      profile={DEFAULT_PROFILE}
      onProfileChange={vi.fn()}
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

describe("SettingsPanel personal profile (D5)", () => {
	it("reports a skin-type change to its owner", () => {
		const onProfileChange = vi.fn();
		render(
			<SettingsPanel
				themePreference="auto"
				onThemePreferenceChange={vi.fn()}
				showSunLines={false}
				onShowSunLinesChange={vi.fn()}
				showSheds={false}
				onShowShedsChange={vi.fn()}
				profile={DEFAULT_PROFILE}
				onProfileChange={onProfileChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /settings/i }));
		fireEvent.change(screen.getByLabelText(/skin type/i), { target: { value: "II" } });
		expect(onProfileChange).toHaveBeenCalledWith(expect.objectContaining({ skinType: "II" }));
	});

	it("reports the overheat toggle and states the profile stays on the device", () => {
		const onProfileChange = vi.fn();
		render(
			<SettingsPanel
				themePreference="auto"
				onThemePreferenceChange={vi.fn()}
				showSunLines={false}
				onShowSunLinesChange={vi.fn()}
				showSheds={false}
				onShowShedsChange={vi.fn()}
				profile={DEFAULT_PROFILE}
				onProfileChange={onProfileChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /settings/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /overheat/i }));
		expect(onProfileChange).toHaveBeenCalledWith(expect.objectContaining({ overheatsEasily: true }));
		expect(screen.getByText(/nothing is sent anywhere/i)).toBeTruthy();
	});
});
