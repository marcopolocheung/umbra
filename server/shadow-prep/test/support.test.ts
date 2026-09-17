import assert from "node:assert/strict";
import test from "node:test";
import { boroughGeometry, supportGeometry } from "../src/support";

const ring = (offset: number) => [
  [offset, 0],
  [offset + 0.75, 0],
  [offset + 0.75, 0.75],
  [offset, 0.75],
  [offset, 0],
];

function productionShapedBoundary() {
  const polygonCounts = [4, 28, 23, 36, 26];
  let next = 0;
  const features = polygonCounts.map((count, featureIndex) => ({
    type: "Feature",
    properties: { borough: featureIndex },
    geometry: {
      type: "MultiPolygon",
      coordinates: Array.from({ length: count }, () => {
        const exterior = ring(next++);
        // The production DCP 26b document has one Manhattan interior ring.
        if (featureIndex === 3 && next === 4 + 28 + 23 + 1) {
          const hole = [
            [exterior[0][0] + 0.1, 0.1],
            [exterior[0][0] + 0.2, 0.1],
            [exterior[0][0] + 0.2, 0.2],
            [exterior[0][0] + 0.1, 0.2],
            [exterior[0][0] + 0.1, 0.1],
          ];
          return [exterior, hole];
        }
        return [exterior];
      }),
    },
  }));
  return { type: "FeatureCollection", features };
}

test("borough parser flattens the five-feature production structure and preserves its interior ring", () => {
  const document = productionShapedBoundary();
  const parsed = boroughGeometry(document);
  assert.equal(parsed.type, "MultiPolygon");
  assert.equal(parsed.coordinates.length, 117);
  assert.equal(parsed.coordinates.reduce((count, polygon) => count + polygon.length, 0), 118);
  const sourceHole = document.features[3].geometry.coordinates[0][1];
  assert.deepEqual(parsed.coordinates[55][1], sourceHole);
});

test("borough parser accepts bare and featured Polygon and MultiPolygon inputs", () => {
  const polygon = { type: "Polygon", coordinates: [ring(0)] };
  const multiPolygon = { type: "MultiPolygon", coordinates: [[ring(1)], [ring(2)]] };
  assert.deepEqual(boroughGeometry(polygon), { type: "MultiPolygon", coordinates: [polygon.coordinates] });
  assert.deepEqual(boroughGeometry({ type: "Feature", properties: {}, geometry: polygon }), {
    type: "MultiPolygon",
    coordinates: [polygon.coordinates],
  });
  assert.deepEqual(boroughGeometry(multiPolygon), multiPolygon);
  assert.deepEqual(
    boroughGeometry({ type: "Feature", properties: {}, geometry: multiPolygon }),
    multiPolygon,
  );
});

test("borough parser rejects empty, mixed, missing, collection, and malformed geometries", () => {
  assert.throws(() => boroughGeometry({ type: "FeatureCollection", features: [] }), /nonempty/);
  assert.throws(
    () => boroughGeometry({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring(0)] } },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
      ],
    }),
    /only Polygon or MultiPolygon/,
  );
  assert.throws(() => boroughGeometry({ type: "Feature", properties: {}, geometry: null }), /no geometry/);
  assert.throws(() => boroughGeometry({ type: "GeometryCollection", geometries: [] }), /only Polygon or MultiPolygon/);
  assert.throws(() => boroughGeometry({ type: "Polygon", coordinates: [] }), /malformed/);
  assert.throws(() => boroughGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }), /malformed/);
  assert.throws(() => boroughGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, Number.NaN], [0, 0]]] }), /malformed/);
  assert.throws(() => boroughGeometry({ type: "Polygon", coordinates: [[[0, 0], [1], [1, 1], [0, 0]]] }), /malformed/);
});

test("source-support parser remains single-feature only", () => {
  const document = productionShapedBoundary();
  assert.throws(() => supportGeometry(document), /single Polygon or MultiPolygon feature/);
  assert.deepEqual(
    supportGeometry({ type: "FeatureCollection", features: [document.features[0]] }),
    document.features[0].geometry,
  );
});
