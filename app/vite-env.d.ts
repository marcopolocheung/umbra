/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FOURSQUARE_API_KEY?: string;
  /** Public Cloudflare Worker origin for immutable NYC shadow browser tiles. */
  readonly VITE_SHADOW_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
