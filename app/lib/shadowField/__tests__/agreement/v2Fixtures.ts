import { gzipSync } from "node:zlib";
import { pointInPolygon } from "../../geometry";
import { composeTile } from "../../v2/compose";
import { decodeComponent, encodeComponent, validateManifestDependencies } from "../../v2/format";
import { tileKey, type OpaqueFlatField } from "../../v2/receivers";
import { STORED_SIZE, type Component, type GenerationManifest } from "../../v2/types";
import type { AgreementFixture } from "./harness";

const CELLS = STORED_SIZE - 2;
const gzip = async (plain: Uint8Array) => new Uint8Array(gzipSync(plain, { level: 6 }));

export interface V2FixtureField {
  field: OpaqueFlatField;
  toMetres(lng: number, lat: number): [number, number];
}

function component(
  kind: Component["kind"],
  tile: string,
  planes: Component["planes"]
): Component {
  return {
    kind,
    identity: {
      generation: "agreement-flat-v2",
      tile,
      sourceHash: `${kind}-fixture-source`,
      recipeHash: "agreement-flat-recipe",
      datumHash: "fixture-egm96-flat",
      hierarchyHash: "fixture-known-empty-exterior",
      licenceHash: "fixture-only",
    },
    evidence: { fixture: "opaque-flat-agreement" },
    planes,
  };
}

function z18Spacing(lat: number): number {
  return (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** 18);
}

function boundsFor(fixture: AgreementFixture, toMetres: (lng: number, lat: number) => [number, number]) {
  const points = fixture.prisms.prisms.flatMap((prism) => prism.ring).concat([fixture.edge.from, fixture.edge.to]);
  const metres = points.map(([lng, lat]) => toMetres(lng, lat));
  return {
    west: Math.min(...metres.map(([east]) => east)) - 8,
    east: Math.max(...metres.map(([east]) => east)) + 8,
    south: Math.min(...metres.map(([, north]) => north)) - 8,
    north: Math.max(...metres.map(([, north]) => north)) + 8,
  };
}

/**
 * Creates only source-separated fixture objects.  They are gzip encoded, decoded,
 * manifest checked and composed before the marcher can receive a field.
 */
export async function buildV2FixtureField(fixture: AgreementFixture): Promise<V2FixtureField> {
  const originLat = fixture.prisms.prisms[0].ring[0][1];
  const toMetres = (lng: number, lat: number): [number, number] => [
    worldX(lng) * z18Spacing(originLat),
    -worldY(lat) * z18Spacing(originLat),
  ];
  const cellSizeM = z18Spacing(originLat);
  const bounds = boundsFor(fixture, toMetres);
  const minTileX = Math.floor(Math.floor(bounds.west / cellSizeM) / CELLS);
  const maxTileX = Math.floor(Math.floor(bounds.east / cellSizeM) / CELLS);
  const minTileY = Math.floor(Math.floor(bounds.south / cellSizeM) / CELLS);
  const maxTileY = Math.floor(Math.floor(bounds.north / cellSizeM) / CELLS);
  const tiles = new Map<string, ReturnType<typeof composeTile>>();
  const words = STORED_SIZE * STORED_SIZE;
  const prismRings = fixture.prisms.prisms.map((prism) => ({
    heightQ: Math.round(prism.heightM * 64),
    ring: prism.ring.map(([lng, lat]) => toMetres(lng, lat)),
  }));

  for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      const buildingAglQ = new Uint32Array(words);
      for (let localY = 0; localY < CELLS; localY++) {
        for (let localX = 0; localX < CELLS; localX++) {
          const eastM = (tileX * CELLS + localX + 0.5) * cellSizeM;
          const northM = (tileY * CELLS + localY + 0.5) * cellSizeM;
          const index = (localY + 1) * STORED_SIZE + localX + 1;
          for (const prism of prismRings) {
            if (pointInPolygon(eastM, northM, prism.ring)) {
              buildingAglQ[index] = prism.heightQ;
              break;
            }
          }
        }
      }
      const tile = tileKey(tileX, tileY);
      const terrain = component("terrain", tile, [
        { name: "groundQ", type: "i32", words: new Uint32Array(words) },
        { name: "foundationQ", type: "i32", words: new Uint32Array(words) },
      ]);
      const buildings = component("buildings", tile, [
        { name: "buildingAglQ", type: "i32", words: buildingAglQ },
      ]);
      const canopy = component("canopy", tile, [
        { name: "flagsAndMaterial", type: "u32", words: new Uint32Array(words) },
      ]);
      const encoded = await Promise.all([terrain, buildings, canopy].map((part) => encodeComponent(part, gzip)));
      const decoded = await Promise.all(encoded.map((part) => decodeComponent(part.bytes)));
      const manifest: GenerationManifest = {
        generation: "agreement-flat-v2",
        recipeHash: "agreement-flat-recipe",
        datumHash: "fixture-egm96-flat",
        hierarchyHash: "fixture-known-empty-exterior",
        components: decoded.map((part, index) => ({
          kind: part.kind,
          tile,
          sourceHash: part.identity.sourceHash,
          recipeHash: part.identity.recipeHash,
          datumHash: part.identity.datumHash,
          hierarchyHash: part.identity.hierarchyHash,
          licenceHash: part.identity.licenceHash,
          objectHash: encoded[index].transportHash,
        })),
      };
      validateManifestDependencies(manifest, decoded);
      tiles.set(tile, composeTile(decoded, { reserve: (bytes) => bytes === words * 24 }));
    }
  }
  return {
    field: { kind: "opaque-flat-v1", cellSizeM, tiles, knownEmptyExterior: true, terrain: "flat", canopy: "known-empty" },
    toMetres,
  };
}

const WORLD_CELLS = 256 * 2 ** 18;
function worldX(lng: number): number { return ((lng + 180) / 360) * WORLD_CELLS; }
function worldY(lat: number): number {
  const radians = (lat * Math.PI) / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) * WORLD_CELLS / 2;
}
