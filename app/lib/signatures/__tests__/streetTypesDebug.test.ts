import { describe, expect, it } from "vitest";
import { streetTypesDebugEnabled } from "../streetTypesDebug";

describe("street-type QA control", () => {
  it.each([undefined, "", "false", "1", "TRUE", "true"])(
    "never enables a production layer with setting %s",
    (setting) => {
      expect(streetTypesDebugEnabled(false, setting)).toBe(false);
    },
  );
  it("requires explicit true in development", () => {
    expect(streetTypesDebugEnabled(true)).toBe(false);
    expect(streetTypesDebugEnabled(true, "false")).toBe(false);
    expect(streetTypesDebugEnabled(true, "true")).toBe(true);
  });
});
