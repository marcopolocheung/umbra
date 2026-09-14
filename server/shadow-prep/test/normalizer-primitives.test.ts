import assert from "node:assert/strict";
import test from "node:test";
import { decodeWkb } from "../src/wkb";
import { bilinearTerrain, transformedTerrainQ } from "../src/terrain-sampling";
import { supportTiles } from "../src/tiles";
import { joinBuildingParts, ownsCellCentre, wholeFoundationQ } from "../src/buildings";

function polygonWithHole(): Uint8Array {
  const bytes = new Uint8Array(1 + 4 + 4 + 2 * (4 + 5 * 16)); const view = new DataView(bytes.buffer); let o=0;
  view.setUint8(o++,1); view.setUint32(o,3,true); o+=4; view.setUint32(o,2,true); o+=4;
  for (const ring of [[[0,0],[2,0],[2,2],[0,2],[0,0]], [[.5,.5],[1.5,.5],[1.5,1.5],[.5,1.5],[.5,.5]]]) { view.setUint32(o,ring.length,true); o+=4; for (const [x,y] of ring) { view.setFloat64(o,x,true);o+=8;view.setFloat64(o,y,true);o+=8; } }
  return bytes;
}
test("strict WKB preserves polygon holes", () => { const value=decodeWkb(polygonWithHole()); assert.equal(value.polygons.length,1); assert.equal(value.polygons[0].holes.length,1); });
test("terrain is bilinear then quantized exactly once", () => { const sample=bilinearTerrain({width:2,height:2,values:new Float64Array([0,10,20,30])},.5,.5); assert.equal(sample,15); assert.equal(transformedTerrainQ(sample,.007),960); });
test("z18 support tiles use the global lattice", () => { const tiles=supportTiles({type:"Polygon",coordinates:[[[-74,40],[-73.999,40],[-73.999,40.001],[-74,40.001],[-74,40]]]}); assert.ok(tiles.length); assert.ok(tiles.every((tile)=>tile.key === `18/${tile.x}/${tile.y}`)); });
test("parents/parts, holes, and whole-feature foundations are deterministic", () => {
  const parent={id:"b",outer:{coordinates:[[0,0],[2,0],[2,2],[0,2],[0,0]]},holes:[{coordinates:[[.5,.5],[1.5,.5],[1.5,1.5],[.5,1.5],[.5,.5]]}],height:10,minHeight:0};
  assert.deepEqual(joinBuildingParts([parent],[{id:"p",buildingId:"b",height:12,minHeight:0}]).map((item)=>item.parts[0].id),["p"]);
  assert.equal(ownsCellCentre(parent.outer,parent.holes,1,1),false); assert.equal(wholeFoundationQ([1,7,9,3]),5);
});
