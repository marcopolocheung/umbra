import assert from "node:assert/strict";
import test from "node:test";
import { loadStops, loadTransfers, parseGtfsTime } from "../src/gtfs";

test("parses midnight-spanning GTFS times", () => {
  assert.equal(parseGtfsTime("08:00:00", "f", 1), 28800);
  assert.equal(parseGtfsTime("25:30:00", "f", 1), 25 * 3600 + 1800);
  assert.throws(() => parseGtfsTime("8:00", "f", 1), /bad time/);
  assert.throws(() => parseGtfsTime("08:60:00", "f", 1), /bad time/);
});

test("loads stops with parent links and surfaces bad coords", () => {
  const { stops, problems } = loadStops(
    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nP,Parent,40.7,-73.9,1,\nC,Child,40.7,-73.9,,P\nB,Bad,xx,-73.9,0,\n",
  );
  assert.equal(stops.length, 2);
  assert.equal(stops[1]?.parent, "P");
  assert.equal(problems.length, 1);
});

test("transfer fallback time defaults to zero when blank", () => {
  const { transfers } = loadTransfers(
    "from_stop_id,to_stop_id,transfer_type,min_transfer_time\nA,B,2,\n",
  );
  assert.equal(transfers[0]?.minTransferSec, 0);
});
