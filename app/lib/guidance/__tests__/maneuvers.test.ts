import { describe, expect, it } from "vitest";
import { bearingDegrees, dijkstra, paretoRoutes, type RoutingGraph } from "../../routing";
import { classifyTurn, generateManeuvers, streetNamesAlong } from "../maneuvers";
import type { GraphEdge } from "../../routing";
import madridRoute from "./fixtures/madrid-plaza-mayor.json";

function nodes(coordinates: [number, number][]) {
  return coordinates.map(([lon, lat]) => ({ lon, lat }));
}

describe("generateManeuvers", () => {
  it("gives only departure and arrival along a subdivided straight street", () => {
    const result = generateManeuvers(nodes([[0, 0], [0, 0.001], [0, 0.002], [0, 0.003]]));
    expect(result.map((m) => m.type)).toEqual(["depart", "arrive"]);
    expect(result[0].distanceFromStartM).toBe(0);
    expect(result[1].distanceFromStartM).toBeCloseTo(333.585, 2);
  });

  it.each([
    [0.001, "turn-right", 90],
    [-0.001, "turn-left", -90],
  ] as const)("turns onto longitude %s with the correct sign", (lon, type, delta) => {
    const result = generateManeuvers(nodes([[0, -0.001], [0, 0], [lon, 0]]));
    expect(result.map((m) => m.type)).toEqual(["depart", type, "arrive"]);
    expect(result[1].bearingDelta).toBeCloseTo(delta, 3);
    expect(result[1].distanceFromStartM).toBeCloseTo(111.195, 2);
    expect(result[2].distanceFromStartM).toBeCloseTo(222.39, 2);
  });

  it("does not chatter on a staircase of small alternating bearing deltas", () => {
    // Survey vertices wiggle by about 11 degrees on a street heading north.
    const path = Array.from({ length: 30 }, (_, i) => ({
      lat: i * 0.0001,
      lon: i % 2 === 0 ? 0 : 0.00001,
    }));
    expect(generateManeuvers(path).map((m) => m.type)).toEqual(["depart", "arrive"]);
  });

  it("retains separate turns when a straight run separates them", () => {
    const result = generateManeuvers(nodes([
      [0, -0.001], [0, 0], [0.001, 0], [0.002, 0], [0.002, 0.001],
    ]));
    expect(result.map((m) => m.type)).toEqual(["depart", "turn-right", "turn-left", "arrive"]);
    expect(result.map((m) => Math.round(m.distanceFromStartM))).toEqual([0, 111, 334, 445]);
  });

  it("ignores repeated positions at departure, turns and arrival without losing distance", () => {
    const path = nodes([[0, -0.001], [0, 0], [0.001, 0]]);
    const repeated = path.flatMap((node) => [node, node, node]);
    expect(generateManeuvers(repeated)).toEqual(generateManeuvers(path));
  });

  it.each([
    [0.0001, "slight-right"],
    [-0.0001, "slight-left"],
  ] as const)("wraps across north without fabricating a sharp turn (%s)", (offset, type) => {
    const result = generateManeuvers(nodes([[offset, -0.0004], [0, 0], [offset, 0.0004]]));
    expect(result[1].type).toBe(type);
    expect(Math.abs(result[1].bearingDelta)).toBeCloseTo(28.072, 2);
  });

  it("represents a reversal as a deterministic sharp left, not a small turn", () => {
    const result = generateManeuvers(nodes([[0, 0], [0, 0.001], [0, 0]]));
    expect(result[1]).toMatchObject({ type: "sharp-left", bearingDelta: -180 });
    expect(result[2].distanceFromStartM).toBeCloseTo(222.39, 2);
  });

  it("returns no guidance without a route, and only arrival for a stationary route", () => {
    expect(generateManeuvers([])).toEqual([]);
    const arrival = [{ type: "arrive", bearingDelta: 0, distanceFromStartM: 0, legIndex: 0 }];
    expect(generateManeuvers(nodes([[0, 0]]))).toEqual(arrival);
    expect(generateManeuvers(nodes([[0, 0], [0, 0]]))).toEqual(arrival);
  });

  it("preserves the supplied leg index without mutating nodes or inventing street/shadow data", () => {
    const path = Object.freeze(nodes([[0, 0], [0, 0.001], [0.001, 0.001]]).map((node) => Object.freeze(node)));
    const result = generateManeuvers(path, 2);
    expect(result.every((m) => m.legIndex === 2)).toBe(true);
    expect(result.every((m) => m.streetName === undefined && m.shadowSideHint === undefined)).toBe(true);
    expect(generateManeuvers(path, 2)).toEqual(result);
  });

  it("gives five street turns on the captured Madrid walk, retaining the short Calle Mayor offset", () => {
    const result = generateManeuvers(madridRoute.nodes);
    expect(result.map((m) => m.type)).toEqual([
      "depart", "turn-right", "turn-left", "turn-right", "turn-left", "turn-right", "arrive",
    ]);
    // West on Zaragoza → north through Plaza Mayor → west on Mayor → north on
    // Coloreros → west through San Ginés → north on Bordadores (see fixture README).
    const distances = [0, 28.6, 126.1, 132.1, 188.2, 223.9, 280.6];
    result.forEach((maneuver, i) => {
      expect(Math.abs(maneuver.distanceFromStartM - distances[i])).toBeLessThan(0.1);
    });
    expect(result[result.length - 1].distanceFromStartM).toBeCloseTo(madridRoute.distanceM, 6);
  });

  it("reverses the captured route's turns and preserves its walking distance", () => {
    const result = generateManeuvers([...madridRoute.nodes].reverse());
    expect(result.map((m) => m.type)).toEqual([
      "depart", "turn-left", "turn-right", "turn-left", "turn-right", "turn-left", "arrive",
    ]);
    expect(result[result.length - 1].distanceFromStartM).toBeCloseTo(madridRoute.distanceM, 6);
  });
});

describe("turn thresholds", () => {
  it.each([
    [0, "continue"], [19.999, "continue"], [-19.999, "continue"],
    [20, "slight-right"], [-20, "slight-left"],
    [49.999, "slight-right"], [-49.999, "slight-left"],
    [50, "turn-right"], [-50, "turn-left"],
    [120, "turn-right"], [-120, "turn-left"],
    [120.001, "sharp-right"], [-120.001, "sharp-left"],
    [179.999, "sharp-right"], [-180, "sharp-left"],
  ] as const)("classifies %s degrees as %s", (delta, type) => {
    expect(classifyTurn(delta)).toBe(type);
  });
});

describe("shared geographic bearings", () => {
  it.each([
    [[0, 1], 0], [[1, 0], 90], [[0, -1], 180], [[-1, 0], 270],
  ] as const)("points toward %s at %s degrees", (destination, bearing) => {
    expect(bearingDegrees([0, 0], [...destination])).toBeCloseTo(bearing, 6);
  });

  it("keeps an eastbound route across the antimeridian straight", () => {
    const path = nodes([[179.998, 0], [179.999, 0], [-179.999, 0]]);
    expect(bearingDegrees([179.999, 0], [-179.999, 0])).toBeCloseTo(90, 6);
    expect(generateManeuvers(path).map((m) => m.type)).toEqual(["depart", "arrive"]);
    expect(generateManeuvers(path)[1].distanceFromStartM).toBeCloseTo(333.585, 2);
  });

  it("uses geographic angles in guidance and both routing turn counts at high latitude", () => {
    // At 60 N, 0.001 degrees of longitude is half the length of a latitude degree.
    // This is a 26.6-degree bend, not the 45-degree turn raw degree differences imply.
    const path = nodes([[0, 59.999], [0, 60], [0.001, 60.001]]);
    const graph: RoutingGraph = {
      nodes: new Map(path.map((node, id) => [id, { ...node, id }])),
      adj: new Map([
        [0, [{ toId: 1, distanceM: 111, shadowFactor: 0 }]],
        [1, [{ toId: 2, distanceM: 124, shadowFactor: 0 }]],
        [2, []],
      ]),
    };
    const result = generateManeuvers(path);
    expect(result[1].type).toBe("slight-right");
    expect(result[1].bearingDelta).toBeCloseTo(26.565, 2);
    expect(dijkstra(graph, 0, 2, 0)?.turnCount).toBe(0);
    const alternatives = paretoRoutes(graph, 0, 2);
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.every((route) => route.turnCount === 0)).toBe(true);
  });
});

describe("generateManeuvers — street names (B2)", () => {
	it("names the street each maneuver proceeds along, not the one left", () => {
		// Two straight runs meeting at a right angle: north along "First", then
		// east along "Second". The turn's name is the street you turn ONTO.
		const path = nodes([[0, 0], [0, 0.001], [0.001, 0.001]]);
		const result = generateManeuvers(path, 0, ["First St", "Second Ave"]);
		const byType = Object.fromEntries(result.map((m) => [m.type, m.streetName]));
		expect(byType.depart).toBe("First St");
		expect(byType["turn-right"] ?? byType["turn-left"]).toBe("Second Ave");
		expect(result.at(-1)?.type).toBe("arrive");
		expect(result.at(-1)?.streetName).toBe("Second Ave");
	});

	it("carries no name when none is supplied", () => {
		const result = generateManeuvers(nodes([[0, 0], [0, 0.001], [0.001, 0.001]]));
		expect(result.every((m) => m.streetName === undefined)).toBe(true);
	});

	it("joins the graph's edge names to the maneuvers via streetNamesAlong", () => {
		// 0 →(First St) 1 →(Second Ave) 2, an L-shaped turn at node 1.
		const graph: RoutingGraph = {
			nodes: new Map([
				[0, { id: 0, lat: 0, lon: 0 }],
				[1, { id: 1, lat: 0, lon: 0.001 }],
				[2, { id: 2, lat: 0.001, lon: 0.001 }],
			]),
			adj: new Map<number, GraphEdge[]>([
				[0, [{ toId: 1, distanceM: 100, shadowFactor: 0, name: "First St" }]],
				[1, [
					{ toId: 0, distanceM: 100, shadowFactor: 0, name: "First St" },
					{ toId: 2, distanceM: 100, shadowFactor: 0, name: "Second Ave" },
				]],
				[2, [{ toId: 1, distanceM: 100, shadowFactor: 0, name: "Second Ave" }]],
			]),
		};
		const nodeIds = [0, 1, 2];
		const path = nodeIds.map((id) => graph.nodes.get(id)!);
		const names = streetNamesAlong(graph, nodeIds);
		expect(names).toEqual(["First St", "Second Ave"]);
		const result = generateManeuvers(path, 0, names);
		expect(result.find((m) => m.type === "depart")?.streetName).toBe("First St");
		expect(result.at(-1)?.streetName).toBe("Second Ave");
	});

	it("keeps names aligned across a skipped zero-length segment", () => {
		// nodes[1] duplicates nodes[2], so segment 1→2 is zero-length and skipped;
		// the name index is derived from i, not a running counter, so it stays put.
		const path = nodes([[0, 0], [0, 0.001], [0, 0.001], [0.001, 0.001]]);
		// names[1] belongs to the skipped segment: a running counter would hand it to the turn.
		const result = generateManeuvers(path, 0, ["First St", "Skipped", "Second Ave"]);
		expect(result.find((m) => m.type === "depart")?.streetName).toBe("First St");
		expect(result.find((m) => m.type === "turn-right")?.streetName).toBe("Second Ave");
		expect(result.at(-1)?.streetName).toBe("Second Ave");
	});
});
