/** Shared hermetic fixture writers. Real GTFS never enters git. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Re-key a fixture's trip_ids with a per-feed tag. Production trip_ids are
 * unique across the six bus feeds; seeding the same fixture into several
 * directories without this makes them collide, which normalizeBus pools into
 * one trip and validate now rejects.
 */
export function withFeedTripIds(files: Record<string, string>, tag: string): Record<string, string> {
  const tagged = { ...files };
  for (const name of ["trips.txt", "stop_times.txt"]) {
    const body = tagged[name];
    if (body) tagged[name] = body.replace(/\b([abc]-\d+)\b/g, `${tag}-$1`);
  }
  return tagged;
}

export async function writeFeed(root: string, dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, dir, name), body);
  }
}

const SUBWAY_STOPS = `stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station
P1,Station Alpha,40.750000,-73.990000,1,
P1N,Station Alpha,40.750000,-73.990000,,P1
P1S,Station Alpha,40.750000,-73.990000,,P1
P2,Station Beta,40.760000,-73.980000,1,
P2N,Station Beta,40.760000,-73.980000,,P2
P2S,Station Beta,40.760000,-73.980000,,P2
`;

const SUBWAY_ROUTES = `route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color,route_sort_order
R1,MTA NYCT,R1,Test Express,Test line,1,https://example.com,FF0000,FFFFFF,1
`;

const SUBWAY_TRIPS = `route_id,trip_id,service_id,trip_headsign,direction_id,shape_id
R1,t-wd-1,Weekday,To Beta,0,S1
R1,t-wd-2,Weekday,To Beta,0,S1
R1,t-wd-3,Weekday,To Beta,0,S1
R1,t-wd-4,Weekday,To Beta,0,S1
R1,t-sa-1,Saturday,To Alpha,1,S1R
`;

const SUBWAY_STOP_TIMES = `trip_id,stop_id,arrival_time,departure_time,stop_sequence
t-wd-1,P1S,08:00:00,08:00:00,1
t-wd-1,P2S,08:05:00,08:05:00,2
t-wd-2,P1S,08:10:00,08:10:00,1
t-wd-2,P2S,08:15:00,08:15:00,2
t-wd-3,P1S,08:20:00,08:20:00,1
t-wd-3,P2S,08:25:00,08:25:00,2
t-wd-4,P1S,08:30:00,08:30:00,1
t-wd-4,P2S,08:35:00,08:35:00,2
t-sa-1,P2N,09:00:00,09:00:00,1
t-sa-1,P1N,09:06:00,09:06:00,2
`;

const SUBWAY_CALENDAR = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
Weekday,1,1,1,1,1,0,0,20260101,20261231
Saturday,0,0,0,0,0,1,0,20260101,20261231
Sunday,0,0,0,0,0,0,1,20260101,20261231
`;

const SUBWAY_SHAPES = `shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon
S1,1,40.750000,-73.990000
S1,2,40.755000,-73.985000
S1,3,40.760000,-73.980000
S1R,1,40.760000,-73.980000
S1R,2,40.750000,-73.990000
`;

export const SUBWAY_FIXTURE: Record<string, string> = {
  "agency.txt":
    "agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone\nMTA NYCT,Test Agency,https://example.com,America/New_York,EN,555-0100\n",
  "stops.txt": SUBWAY_STOPS,
  "routes.txt": SUBWAY_ROUTES,
  "trips.txt": SUBWAY_TRIPS,
  "stop_times.txt": SUBWAY_STOP_TIMES,
  "calendar.txt": SUBWAY_CALENDAR,
  "calendar_dates.txt": "service_id,date,exception_type\n",
  "shapes.txt": SUBWAY_SHAPES,
  "transfers.txt":
    "from_stop_id,to_stop_id,transfer_type,min_transfer_time\nP1,P2,2,120\nP1,P1,2,180\nP2,P2,2,0\n",
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_contact_url\nMTA,https://example.com,EN,20260101,20261231,test-subway-1,https://example.com\n",
};

const BUS_ROUTES = `route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color,route_text_color
V1,MTA NYCT,B1,Shared Line,via Test,3,00AEEF,FFFFFF
V2,MTA NYCT,B1,Shared Line Variant,via Test Alt,3,00AEEF,FFFFFF
V3,MTA NYCT,B2,Other Line,via Other,3,006CB7,FFFFFF
`;

const BUS_CALENDAR = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WD,1,1,1,1,1,0,0,20260101,20261231
SA,0,0,0,0,0,1,0,20260101,20261231
`;

/** Bus fixture A: shared stop S1 + own stop A2; V1/V2 are B1 variants. */
export function busFixtureA(): Record<string, string> {
  return {
    "agency.txt":
      "agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone\nMTA NYCT,Test Agency,https://example.com,America/New_York,EN,555-0100\n",
    "stops.txt": `stop_id,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station
S1,Shared Stop,,40.751000,-73.989000,,,0,
A2,Alpha Two,,40.752000,-73.988000,,,0,
`,
    "routes.txt": BUS_ROUTES,
    "trips.txt": `route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id
V1,WD,a-1,To A2,0,,BS1
V1,WD,a-2,To A2,0,,BS1
V1,WD,a-3,To A2,0,,BS1
V1,WD,a-4,To A2,0,,BS1
V2,WD,a-5,To A2 Alt,0,,BS1
V1,HOL,a-6,Holiday Extra,0,,BS1
`,
    "stop_times.txt": `trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint
a-1,08:00:00,08:00:00,S1,1,0,0,1
a-1,08:04:00,08:04:00,A2,2,0,0,1
a-2,08:12:00,08:12:00,S1,1,0,0,1
a-2,08:16:00,08:16:00,A2,2,0,0,1
a-3,08:24:00,08:24:00,S1,1,0,0,1
a-3,08:28:00,08:28:00,A2,2,0,0,1
a-4,08:36:00,08:36:00,S1,1,0,0,1
a-4,08:40:00,08:40:00,A2,2,0,0,1
a-5,08:48:00,08:48:00,S1,1,0,0,1
a-5,08:52:00,08:52:00,A2,2,0,0,1
a-6,09:00:00,09:00:00,S1,1,0,0,1
a-6,09:04:00,09:04:00,A2,2,0,0,1
`,
    "calendar.txt": BUS_CALENDAR,
    "calendar_dates.txt": "service_id,date,exception_type\nHOL,20261126,1\n",
    "shapes.txt": `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
BS1,40.751000,-73.989000,1
BS1,40.752000,-73.988000,2
`,
    "feed_info.txt":
      "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_contact_url\nMTA,https://example.com,en,20260101,20261231,test-bus-1,https://example.com\n",
  };
}

/** Bus fixture B: same shared stop S1 (~7 m off, like NYCT-vs-BusCo drift) + own stop B2. */
export function busFixtureB(): Record<string, string> {
  return {
    "agency.txt":
      "agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone\nMTA NYCT,Test Agency,https://example.com,America/New_York,EN,555-0100\n",
    "stops.txt": `stop_id,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station
S1,Shared Stop,,40.751050,-73.988950,,,0,
B2,Beta Two,,40.753000,-73.987000,,,0,
`,
    "routes.txt": BUS_ROUTES,
    "trips.txt": `route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id
V3,WD,b-1,To B2,0,,BS2
V3,WD,b-2,To B2,0,,BS2
V3,WD,b-3,To B2,0,,BS2
`,
    "stop_times.txt": `trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint
b-1,09:00:00,09:00:00,S1,1,0,0,1
b-1,09:05:00,09:05:00,B2,2,0,0,1
b-2,09:15:00,09:15:00,S1,1,0,0,1
b-2,09:20:00,09:20:00,B2,2,0,0,1
b-3,09:30:00,09:30:00,S1,1,0,0,1
b-3,09:35:00,09:35:00,B2,2,0,0,1
`,
    "calendar.txt": BUS_CALENDAR,
    "calendar_dates.txt": "service_id,date,exception_type\n",
    "shapes.txt": `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
BS2,40.751000,-73.989000,1
BS2,40.753000,-73.987000,2
`,
    "feed_info.txt":
      "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_contact_url\nMTA,https://example.com,en,20260101,20261231,test-bus-1,https://example.com\n",
  };
}

/**
 * BusCo-shaped fixture: minimal 5-column stops, routes WITH route_url, and
 * route_ids disjoint from the NYCT table (mirrors production).
 */
export function busFixtureBusco(): Record<string, string> {
  return {
    "agency.txt":
      "agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone\nMTA BUS,Test BusCo,https://example.com,America/New_York,EN,555-0100\n",
    "stops.txt": `stop_id,stop_name,stop_desc,stop_lat,stop_lon
S1,Shared Stop,,40.751000,-73.989000
C2,Charlie Two,,40.754000,-73.986000
`,
    "routes.txt": `route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color
X1,MTA BUS,XB1,BusCo Line,via Test,3,https://example.com,00AEEF,FFFFFF
X2,MTA BUS,XB1,BusCo Line Variant,via Test Alt,3,https://example.com,00AEEF,FFFFFF
X3,MTA BUS,XB2,BusCo Other,via Other,3,https://example.com,006CB7,FFFFFF
`,
    "trips.txt": `route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id
X1,WD,c-1,To C2,0,,BSX
X1,WD,c-2,To C2,0,,BSX
X1,WD,c-3,To C2,0,,BSX
`,
    "stop_times.txt": `trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint
c-1,09:00:00,09:00:00,S1,1,0,0,1
c-1,09:04:00,09:04:00,C2,2,0,0,1
c-2,09:15:00,09:15:00,S1,1,0,0,1
c-2,09:19:00,09:19:00,C2,2,0,0,1
c-3,09:30:00,09:30:00,S1,1,0,0,1
c-3,09:34:00,09:34:00,C2,2,0,0,1
`,
    "calendar.txt": BUS_CALENDAR,
    "calendar_dates.txt": "service_id,date,exception_type\n",
    "shapes.txt": `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
BSX,40.751000,-73.989000,1
BSX,40.754000,-73.986000,2
`,
    "feed_info.txt":
      "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_contact_url\nMTA,https://example.com,en,20260101,20261231,test-bus-1,https://example.com\n",
  };
}
