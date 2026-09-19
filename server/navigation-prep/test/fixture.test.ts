import assert from "node:assert/strict";
import test from "node:test";
import {
  parseNavigationBuildingShard,
  parseNavigationManifest,
  parseNavigationNotices,
  parseNavigationPointer,
  parseNavigationStreetShard,
} from "../../../app/lib/navigationData/shardContract";
import { jsonBytes, sha256Hex } from "../src/canonical";
import { buildFixtureGeneration, REJECTED_FIXTURE_BUILDINGS } from "../src/fixture";
import { isSourceReceipt, navigationAcquisitionPlan } from "../src/sources";

test("source plan keeps real acquisition outside git and receipts strict", () => {
  const plan = navigationAcquisitionPlan();
  assert.equal(plan.rawOutsideGit, true);
  assert.equal(plan.sources.length, 2);
  assert.ok(plan.sources.every((source) => source.path.startsWith("<NAVIGATION_PREP_ROOT>/")));
  assert.equal(
    isSourceReceipt({
      id: "osm",
      release: "r",
      url: "https://example.test/osm.pbf",
      bytes: 1000,
      timestamp: "2026-09-18T00:00:00Z",
      sha256: "a".repeat(64),
    }),
    true,
  );
  assert.equal(
    isSourceReceipt({
      id: "osm",
      release: "r",
      url: "file:///tmp/osm",
      bytes: 1000,
      timestamp: "2026-09-18T00:00:00Z",
      sha256: "a".repeat(64),
    }),
    false,
  );
  assert.equal(
    isSourceReceipt({
      id: "osm",
      release: "r",
      url: "https://example.test/osm.pbf",
      sha256: "bad",
    }),
    false,
  );
});

test("fixture generation is deterministic and round-trips every published object", () => {
  const first = buildFixtureGeneration();
  const second = buildFixtureGeneration();
  assert.equal(first.generation, second.generation);
  assert.deepEqual([...first.bytes], [...second.bytes]);

  const pointer = parseNavigationPointer(first.pointer);
  const manifest = parseNavigationManifest(first.manifest, pointer.generation);
  assert.equal(manifest.generation, first.generation);
  parseNavigationNotices(first.notices, first.generation);

  for (const ref of manifest.streetShards) {
    const value = first.streetShards.get(ref.key);
    assert.ok(value);
    parseNavigationStreetShard(value, ref, first.generation);
    assert.equal(sha256Hex(jsonBytes(value)), ref.sha256);
  }
  for (const ref of manifest.buildingShards) {
    const value = first.buildingShards.get(ref.key);
    assert.ok(value);
    parseNavigationBuildingShard(value, ref, first.generation);
    assert.equal(sha256Hex(jsonBytes(value)), ref.sha256);
  }
});

test("fixture preserves a cross-cell edge and an explicit unknown height", () => {
  const fixture = buildFixtureGeneration();
  const west = fixture.streetShards.get("streets/z14-west.json");
  const east = fixture.streetShards.get("streets/z14-east.json");
  assert.ok(west && east);
  assert.ok(west.edges.some((edge) => edge.from === 1002 && edge.to === 1003));
  assert.ok(west.nodes.some((node) => node.id === 1003));
  assert.ok(east.nodes.some((node) => node.id === 1002));

  const eastBuildings = fixture.buildingShards.get("buildings/z14-east.json");
  assert.ok(eastBuildings);
  assert.equal(eastBuildings.buildings[0].heightM, null);
  assert.equal(eastBuildings.buildings[0].heightSource, "unknown");
  assert.equal(REJECTED_FIXTURE_BUILDINGS[0].featureCode, 1003);
});
