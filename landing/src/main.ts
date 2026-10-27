import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles.css";
import { mountChain } from "./chain.ts";
import { mountDemo } from "./demo.ts";
import { mountSizer } from "./sizer.ts";

// Everything on the page works and reads fully without motion. The motion layer is loaded after first paint, and
// never for people who ask their system for reduced motion.
mountDemo();
const sizer = document.querySelector<HTMLFormElement>("[data-sizer]");
if (sizer) mountSizer(sizer);
const chain = document.querySelector<HTMLElement>("[data-chain]");
if (chain) mountChain(chain);

// masthead: a backing once the page moves, out of the way while reading down, back on any scroll up
const head = document.querySelector<HTMLElement>("[data-masthead]");
let lastY = window.scrollY;
let ticking = false;
const onScroll = () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const y = window.scrollY;
    head?.classList.toggle("is-scrolled", y > 24);
    head?.classList.toggle("is-hidden", y > 640 && y > lastY + 4 && !head.contains(document.activeElement));
    if (y < lastY - 4 || y <= 640) head?.classList.remove("is-hidden");
    lastY = y;
    ticking = false;
  });
};
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
const startMotion = () => {
  if (reduce.matches) return;
  import("./motion.ts").then((m) => m.startMotion()).catch(() => {});
};
if (document.readyState === "complete") requestIdleCallbackish(startMotion);
else window.addEventListener("load", () => requestIdleCallbackish(startMotion), { once: true });

function requestIdleCallbackish(fn: () => void) {
  if ("requestIdleCallback" in window) window.requestIdleCallback(fn, { timeout: 600 });
  else setTimeout(fn, 60);
}
