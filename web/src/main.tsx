import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// ADR-062: installable as an app (no offline cache; see public/sw.js)
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
