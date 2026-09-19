declare module "osm-pbf-parser" {
  import type { Duplex } from "node:stream";

  interface OsmItem {
    type: "node" | "way" | "relation";
    id: number;
    lat?: number;
    lon?: number;
    tags?: Record<string, string>;
    refs?: number[];
    info?: Record<string, unknown>;
  }

  function parser(): Duplex;
  export = parser;
}
