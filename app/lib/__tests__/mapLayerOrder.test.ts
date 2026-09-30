import { describe, expect, it } from "vitest";
import { reconcileMapLayerOrder } from "../mapLayerOrder";

type LayerOrderMap = Parameters<typeof reconcileMapLayerOrder>[0];

function fakeMap(initial: string[]) {
  const order = [...initial];
  let moves = 0;
  const map = {
    getLayersOrder: () => [...order],
    moveLayer: (id: string) => {
      const at = order.indexOf(id);
      if (at < 0) throw new Error(`missing ${id}`);
      order.splice(at, 1);
      order.push(id);
      moves++;
    },
  } as unknown as LayerOrderMap;
  return {
    map,
    order,
    add: (id: string) => { order.push(id); },
    moves: () => moves,
  };
}

const symbols = ["street-label", "poi-icon-and-label", "place-label"];

describe("map layer order", () => {
  it("keeps route strokes above buildings and all basemap symbols above the route", () => {
    const fake = fakeMap([
      "land", symbols[0], "roads", symbols[1], symbols[2],
      "nav-route-casing", "nav-route-line", "local-shadow-layer",
    ]);

    reconcileMapLayerOrder(fake.map, symbols, "local-shadow-layer");
    expect(fake.order).toEqual([
      "land", "roads", "local-shadow-layer", "nav-route-casing", "nav-route-line",
      ...symbols,
    ]);
    const moves = fake.moves();
    reconcileMapLayerOrder(fake.map, symbols, "local-shadow-layer");
    expect(fake.moves()).toBe(moves);
  });

  it("restores order after late transit and connector layers arrive", () => {
    const fake = fakeMap(["land", "local-shadow-layer", "nav-route-casing", "nav-route-line", ...symbols]);
    fake.add("train-route-lines-layer");
    fake.add("train-route-stops-layer");
    fake.add("train-route-transfers-outer");
    fake.add("train-route-transfers-inner");
    fake.add("mrt-entrance-connector-casing");
    fake.add("mrt-entrance-connector-line");

    reconcileMapLayerOrder(fake.map, symbols, "local-shadow-layer");
    expect(fake.order).toEqual([
      "land", "local-shadow-layer", "nav-route-casing", "nav-route-line",
      "train-route-lines-layer", "mrt-entrance-connector-casing", "mrt-entrance-connector-line",
      ...symbols, "train-route-stops-layer", "train-route-transfers-outer", "train-route-transfers-inner",
    ]);
  });

  it("keeps sketch and preview lines below labels after a pitch or idle reconciliation", () => {
    const fake = fakeMap([
      "land", "local-shadow-layer", ...symbols,
      "sketch-line-casing", "sketch-line-layer", "sketch-preview-layer",
    ]);
    reconcileMapLayerOrder(fake.map, symbols, "local-shadow-layer");
    expect(fake.order).toEqual([
      "land", "local-shadow-layer", "sketch-line-casing", "sketch-line-layer",
      "sketch-preview-layer", ...symbols,
    ]);
    const moves = fake.moves();
    reconcileMapLayerOrder(fake.map, symbols, "local-shadow-layer");
    expect(fake.moves()).toBe(moves);
  });

  it("handles a fixture with no symbols or custom shadow layer", () => {
    const fake = fakeMap(["land", "nav-route-line", "nav-route-casing"]);
    reconcileMapLayerOrder(fake.map, [], undefined);
    expect(fake.order).toEqual(["land", "nav-route-casing", "nav-route-line"]);
  });
});
