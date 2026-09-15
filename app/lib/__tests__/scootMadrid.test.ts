/**
 * E4 acceptance: on a sett-heavy Madrid-centre fixture, scoot mode routes
 * materially differently from walk mode — not just a different node list, a
 * stated drop in rough-surface share. Loads the committed fixture through
 * `buildRoutingGraphFromElements`, the exact production code path (no
 * network, no env). ODbL attribution lives on the fixture file.
 */
import { describe, expect, it } from "vitest";
import { dijkstra } from "../routing";
import { buildRoutingGraphFromElements } from "../overpass";
import { roughSurfaceLine, roughSurfacesFor } from "../travelMode";
import fixture from "./madrid-centre.fixture";

/** Share of physical metres on scoot-rough surfaces. */
function roughShareOf(result: { distanceM: number; surfaceMetresM: Record<string, number> }): number {
  const rough = roughSurfacesFor("scoot");
  let metres = 0;
  for (const [surface, m] of Object.entries(result.surfaceMetresM)) {
    if (rough.has(surface)) metres += m;
  }
  return result.distanceM > 0 ? metres / result.distanceM : 0;
}

// Calle de la Lechuga × Calle del León corridor, SE of Puerta del Sol: the
// walking desire line runs over untagged sett; smooth asphalt runs parallel.
const START = 21734300;
const END = 351959168;

describe("scoot vs walk on the Madrid-centre fixture (E4 acceptance)", () => {
  it("walks the sett desire line but scoots around it", () => {
    const graph = buildRoutingGraphFromElements(fixture.elements);

    const walk = dijkstra(graph, START, END, 0, { travelMode: "walk" })!;
    const scoot = dijkstra(graph, START, END, 0, { travelMode: "scoot" })!;

    // Material difference, stated as rough-surface share — not node identity.
    expect(roughShareOf(walk)).toBeGreaterThan(0.9);
    expect(roughShareOf(scoot)).toBeLessThan(0.1);
    expect(scoot.nodeIds.join(",")).not.toBe(walk.nodeIds.join(","));
    // … at a sane detour, not a tour of the district.
    expect(scoot.distanceM / walk.distanceM).toBeLessThan(2);
  });

  it("confesses it when the scoot route cannot avoid rough surfaces", () => {
    const graph = buildRoutingGraphFromElements(fixture.elements);
    // A shorter hop deep in the sett block: scoot still crosses stone.
    const scoot = dijkstra(graph, 21734304, END, 0, { travelMode: "scoot" })!;
    expect(roughShareOf(scoot)).toBeGreaterThan(0);
    expect(roughSurfaceLine(scoot.surfaceMetresM, "scoot")).toMatch(
      /includes \d+ m of (sett|cobblestone)/,
    );
  });
});
