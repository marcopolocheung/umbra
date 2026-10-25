/**
 * H6 held-out cases: "is this outing possible?" answered from a typed
 * certificate. The model's write turn proposes a feasibility receipt; only a
 * status that matches the certificate verifies, and the rendered words come
 * from the certificate, never the model.
 */
import type { FeasibilityCertificate, FeasibilityStatus } from "../../../reach/feasibility";
import type { Scenario } from "../harness";

export const HOME = { lat: 40.7536, lng: -73.984 };
export const CAFE = { name: "Bryant Park Cafe", lat: 40.7547, lng: -73.9836 };
const ASK = "Can I walk to Bryant Park Cafe, have coffee for 15 minutes, and be home within 45 minutes on under 8 minutes of sun?";

export function certificate(status: FeasibilityStatus, extra: Partial<FeasibilityCertificate> = {}): FeasibilityCertificate {
  return {
    status,
    question: { start: [HOME.lng, HOME.lat], target: [CAFE.lng, CAFE.lat], sunMin: 8, timeMin: 45, stayMin: 15, departure: "2026-07-01T19:00:00Z" },
    inputVersion: 1,
    modelVersion: "sun-budget-h6-1",
    geometryVersion: "nyc-2026-09-18-393d4cd24a30",
    ...extra,
  };
}

/** A scenario that resolves home and the café, checks the outing, and proposes `claimed`. */
export function outingScenario(id: string, intent: string, answer: FeasibilityCertificate, claimed: FeasibilityStatus): Scenario {
  return {
    id,
    intent,
    userText: `${ASK} I'm here.`,
    tools: {
      locate_user: { lat: HOME.lat, lng: HOME.lng },
      geocode_place: { results: [CAFE] },
      check_sun_budget: answer as unknown as Record<string, unknown>,
    },
    script: [
      { calls: [{ name: "locate_user" }] },
      { calls: [{ name: "geocode_place", args: { query: "Bryant Park Cafe" } }] },
      {
        calls: [
          {
            name: "check_sun_budget",
            args: { startLat: HOME.lat, startLng: HOME.lng, targetLat: CAFE.lat, targetLng: CAFE.lng, sunMin: 8, timeMin: 45, stayMin: 15 },
          },
        ],
      },
      { text: "draft" },
      {
        text: JSON.stringify({
          blocks: [{ kind: "text", text: "Here is the check." }, { kind: "claim", claimId: "outing-1" }],
          receipts: [{ claimId: "outing-1", kind: "feasibility", subject: "outing", value: { status: claimed }, supportingResultIds: ["result-3"] }],
        }),
      },
    ],
    grounded: [CAFE.name],
    maxLlmCalls: 5,
    maxToolCalls: 4,
    expect: {
      tool: "check_sun_budget",
      toolOrder: ["locate_user", "geocode_place", "check_sun_budget", "plot_points"],
      plotsBeforeWrite: true,
      answer: "",
    },
  };
}
