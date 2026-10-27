import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// ADR-077: the static demo cockpit answers the API in the browser (only in `pnpm web:demo` builds)
if (import.meta.env.VITE_DEMO === "1") await import("./demo.ts");

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// ADR-062: installable as an app (no offline cache; see public/sw.js)
if ("serviceWorker" in navigator && location.protocol === "https:" && import.meta.env.VITE_DEMO !== "1") {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
