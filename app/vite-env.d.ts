/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FOURSQUARE_API_KEY?: string;
  /** Public Cloudflare Worker origin for immutable NYC shadow browser tiles. */
  readonly VITE_SHADOW_API_BASE?: string;
  /** Public origin serving the published NYC transit dataset. Absent = off. */
  readonly VITE_TRANSIT_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
