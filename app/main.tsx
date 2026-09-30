import "./lib/storageMigration";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./globals.css";
import Home from "./page";
import About from "./about/page";
import { applyUiTheme, readThemePreference, resolveUiTheme } from "./lib/uiTheme";

// A saved Day/Night override paints before React mounts, and reaches /about, which
// has no map place. On Auto this is day until useUiTheme knows the place.
applyUiTheme(resolveUiTheme(readThemePreference(), "day"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[pwa] Service worker registration failed", err);
    });
  });
}
