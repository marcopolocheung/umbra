import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { handleOverpassRequest } from "./server/overpassProxy.js";

function overpassDevProxy(): Plugin {
  return {
    name: "umbra-overpass-proxy",
    configureServer(server) {
      server.middlewares.use("/__overpass", (req, res) => {
        void handleOverpassRequest(req, res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const shadowBase = (env.VITE_SHADOW_API_BASE ?? "").replace(/\/$/, "");
  return {
  plugins: [overpassDevProxy(), react()],
  // Foursquare Places API does not allow browser CORS from arbitrary origins.
  // During local development, proxy through Vite so requests are same-origin.
  // In production, this should be handled by your hosting layer (reverse proxy
  // / serverless function) to avoid exposing the API key and to satisfy CORS.
  server: {
    proxy: {
      "/__fsq": {
        target: "https://places-api.foursquare.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/__fsq/, ""),
        configure: (proxy) => {

        },
      },
      // Nominatim: the OSMF policy wants a User-Agent, which browsers forbid
      // setting. Route dev requests through Vite so a real one is attached
      // server-side, matching the prod /api/nominatim proxy.
      "/__nominatim": {
        target: "https://nominatim.openstreetmap.org",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => {
          const url = new URL(path, "http://localhost");
          const endpoint = url.searchParams.get("endpoint") === "reverse" ? "reverse" : "search";
          url.searchParams.delete("endpoint");
          url.searchParams.set("format", "json");
          return `/${endpoint}?${url.searchParams.toString()}`;
        },
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("User-Agent", "Umbra/1.0 (+https://shademapnav.vercel.app)");
          });
        },
      },
      // Gemini (agent LLM, via its OpenAI-compatible endpoint): route dev
      // requests through Vite to sidestep CORS. The browser sends
      // Authorization: Bearer <VITE_GEMINI_API_KEY> (dev only).
      "/__gemini": {
        target: "https://generativelanguage.googleapis.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/__gemini/, ""),
      },
      // Browser debug requests use a same-origin prefix in local development.
      // Keep this absent when no Worker origin is configured instead of silently
      // forwarding to an arbitrary host.
      ...(shadowBase ? {
        "/__shadow": {
          target: shadowBase,
          changeOrigin: true,
          secure: true,
          rewrite: (path: string) => path.replace(/^\/__shadow/, ""),
        },
      } : {}),
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Function form keeps chunking compatible across Vite/Rollup versions.
        manualChunks: (id) => {
          if (id.includes("node_modules/maplibre-gl")) return "maplibre";
          if (
            id.includes("node_modules/react-router-dom") ||
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react/")
          ) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
};
});
