import { mockRoute } from "../mock-api.ts";

/**
 * Public demo cockpit (ADR-077, PSS-037…039): the real panel on synthetic data, as static files for the website. Every
 * `/api/*` call is answered in the browser from the same fixtures `pnpm web:dev` serves; nothing leaves the page.
 * Only `pnpm web:demo` includes this file (the production build tree-shakes it away).
 */
const scenario = new URLSearchParams(location.search).has("alert")
  ? "alert"
  : new URLSearchParams(location.search).has("empty")
    ? "empty"
    : "normal";

const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    location.href,
  );
  const i = u.pathname.indexOf("/api/");
  if (i < 0) return real(input, init);
  await new Promise((r) => setTimeout(r, 120)); // feel like a network
  const r = mockRoute(u.pathname.slice(i), u.searchParams, scenario, Date.now());
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
};

const banner = document.createElement("div");
banner.className = "demo-banner";
banner.textContent = "DEMO · synthetic data · nothing here is real money or a real account";
document.body.prepend(banner);
