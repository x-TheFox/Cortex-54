/**
 * The demo button (the page's one hard requirement): a full-screen dialog around the real operator cockpit built by
 * `pnpm web:demo` (ADR-077), served from ./demo/ next to this page. Every API call inside it is answered in the
 * browser from synthetic fixtures; the cockpit shows its own amber DEMO banner as well as this dialog's.
 */
const BASE = "./demo/";

export function mountDemo(): { open: () => void } {
  const dialog = document.querySelector<HTMLDialogElement>("[data-demo]");
  const frame = document.querySelector<HTMLIFrameElement>("[data-demo-frame]");
  const loading = document.querySelector<HTMLElement>("[data-demo-loading]");
  const newTab = document.querySelector<HTMLAnchorElement>("[data-demo-newtab]");
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-scenario]")];
  if (!dialog || !frame) return { open: () => {} };

  let scenario = "";
  const src = () => `${BASE}${scenario ? `?${scenario}` : ""}`;

  const load = () => {
    frame.classList.remove("is-ready");
    if (loading) loading.hidden = false;
    frame.src = src();
    if (newTab) newTab.href = src();
  };
  frame.addEventListener("load", () => {
    if (!frame.src) return;
    frame.classList.add("is-ready");
    if (loading) loading.hidden = true;
  });

  const open = () => {
    if (dialog.open) return;
    if (!frame.src) load();
    document.documentElement.classList.add("has-dialog");
    window.dispatchEvent(new CustomEvent("cortex:dialog", { detail: true }));
    dialog.showModal();
    if (location.hash !== "#demo") history.replaceState(null, "", "#demo");
  };
  const close = () => dialog.close();

  dialog.addEventListener("close", () => {
    document.documentElement.classList.remove("has-dialog");
    window.dispatchEvent(new CustomEvent("cortex:dialog", { detail: false }));
    if (location.hash === "#demo") history.replaceState(null, "", location.pathname + location.search);
  });

  for (const b of document.querySelectorAll<HTMLElement>("[data-demo-open]"))
    b.addEventListener("click", open);
  document.querySelector("[data-demo-close]")?.addEventListener("click", close);
  for (const t of tabs) {
    t.addEventListener("click", () => {
      scenario = t.dataset.scenario ?? "";
      for (const o of tabs) o.setAttribute("aria-pressed", String(o === t));
      load();
    });
  }

  if (location.hash === "#demo") open();
  return { open };
}
