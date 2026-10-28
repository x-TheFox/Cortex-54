import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { DOCTRINE } from "../../src/generated/config.ts";

/**
 * The motion layer. Measured, never bouncy: an idea moves through a process, so the motion is procedural — strike,
 * hand over, stack, settle. Every scene's end state equals the static page, so nothing depends on watching it.
 */
gsap.registerPlugin(ScrollTrigger);

const EASE = "expo.out";
const DESKTOP = "(min-width: 1081px) and (min-height: 720px)";

export function startMotion(): void {
  const lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 0.95 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  window.addEventListener("cortex:dialog", (e) =>
    (e as CustomEvent<boolean>).detail ? lenis.stop() : lenis.start(),
  );
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (!id || id === "#") return;
      const target = document.querySelector<HTMLElement>(id);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: id === "#top" ? 0 : -72, duration: 1.4 });
      history.replaceState(null, "", id);
    });
  }

  heroScene();
  revealScenes();
  ladderScene();
  windowScene();

  const mm = gsap.matchMedia();
  mm.add(DESKTOP, () => {
    funnelScene(true);
    courtScene();
  });
  mm.add(`not all and ${DESKTOP}`, () => {
    funnelScene(false);
  });

  // fonts and late images shift layout; re-measure once they settle
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
}

function heroScene() {
  const file = document.querySelector<HTMLElement>("[data-hero-file]");
  if (!file) return;
  const tl = gsap.timeline({
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: 0.6 },
  });
  tl.to(".slip-a", { y: -70, rotate: -6, ease: "none" }, 0)
    .to(".slip-b", { y: -150, rotate: 4, ease: "none" }, 0)
    .to(".slip-c", { y: -240, rotate: 1.5, ease: "none" }, 0)
    .to(".hero-copy", { y: -40, ease: "none" }, 0);
}

function revealScenes() {
  for (const head of document.querySelectorAll<HTMLElement>(".chapter-head")) {
    gsap.from(head.children, {
      y: 36,
      opacity: 0,
      duration: 1.2,
      ease: EASE,
      stagger: 0.08,
      scrollTrigger: { trigger: head, start: "top 82%", once: true },
    });
  }
  ScrollTrigger.batch("[data-reveal]", {
    start: "top 88%",
    once: true,
    onEnter: (els) =>
      gsap.from(els, { y: 32, opacity: 0, duration: 1.1, ease: EASE, stagger: 0.07, overwrite: true }),
  });
  for (const group of [".caps", ".limits", ".docket"]) {
    const el = document.querySelector(group);
    if (!el) continue;
    gsap.from(el.children, {
      y: 18,
      opacity: 0,
      duration: 1,
      ease: EASE,
      stagger: 0.06,
      scrollTrigger: { trigger: el, start: "top 90%", once: true },
    });
  }
}

/** I · intake: each tier strikes its headlines, with the reason, in order; one survives to the court. */
function funnelScene(pin: boolean) {
  const funnel = document.querySelector<HTMLElement>("[data-funnel]");
  if (!funnel) return;
  const rows = [...funnel.querySelectorAll<HTMLElement>(".hl")];
  const tiers = [...funnel.querySelectorAll<HTMLElement>("[data-tier-step]")];
  const count = funnel.querySelector<HTMLElement>("[data-wire-count]");
  const dead = (k: string) => rows.filter((r) => r.dataset.dies === k);
  const win = rows.filter((r) => r.dataset.dies === "court");

  funnel.classList.add("is-live");
  gsap.set(rows, { "--strike": 0, "--reason": 0, "--dim": 0 });
  gsap.set(win, { "--win": 0 });

  const alive = [rows.length];
  for (const k of ["0", "1", "2"]) alive.push((alive.at(-1) ?? 0) - dead(k).length);

  if (count) count.textContent = String(rows.length);

  const tl = gsap.timeline({ defaults: { ease: "power2.inOut" } });
  ["0", "1", "2"].forEach((k, i) => {
    const d = dead(k);
    tl.addLabel(`t${i}`)
      .to(d, { "--strike": 1, duration: 0.6, stagger: 0.12 }, `t${i}`)
      .to(d, { "--reason": 1, "--dim": 1, duration: 0.5, stagger: 0.12 }, `t${i}+=0.3`)
      .to({}, { duration: 0.35 });
  });
  tl.addLabel("court")
    .to(win, { "--win": 1, "--reason": 1, duration: 0.6, ease: EASE }, "court")
    .to({}, { duration: 0.3 });
  // keep counts right when scrubbing backwards past a label
  tl.eventCallback("onUpdate", () => {
    const labels = ["t0", "t1", "t2", "court"].map((l) => tl.labels[l] ?? 0);
    const t = tl.time();
    let step = -1;
    labels.forEach((at, i) => {
      if (t >= at + 0.001) step = i;
    });
    if (step >= 0) {
      for (const [j, x] of tiers.entries()) x.classList.toggle("is-on", j === step);
      if (count) count.textContent = String(step >= 3 ? win.length : (alive[step + 1] ?? rows.length));
    } else {
      for (const x of tiers) x.classList.remove("is-on");
      if (count) count.textContent = String(rows.length);
    }
  });

  if (pin) {
    funnel.classList.add("is-pinned");
    ScrollTrigger.create({
      trigger: funnel,
      start: "top 96px",
      end: "+=1700",
      pin: true,
      scrub: 0.8,
      animation: tl,
    });
  } else {
    ScrollTrigger.create({
      trigger: funnel.querySelector(".wire"),
      start: "top 70%",
      animation: tl,
      once: true,
    });
    tl.timeScale(1.3);
  }
  return () => {
    funnel.classList.remove("is-live", "is-pinned");
    gsap.set(rows, { clearProps: "--strike,--reason,--dim,--win" });
  };
}

/** II · hearing: transcript entries stack, each new speaker sliding over the last; the index follows. */
function courtScene() {
  const court = document.querySelector<HTMLElement>("[data-court]");
  if (!court) return;
  const entries = [...court.querySelectorAll<HTMLElement>(".entry")];
  const index = [...court.querySelectorAll<HTMLElement>(".court-index li")];
  const list = court.querySelector<HTMLElement>(".transcript");
  if (!list || entries.length === 0) return;

  list.style.gridTemplateAreas = '"stack"';
  for (const e of entries) e.style.gridArea = "stack";
  list.style.alignItems = "start";
  list.style.paddingTop = "64px";
  list.style.minHeight = "calc(100vh - 220px)";
  list.style.alignContent = "center";
  court.style.alignItems = "center";

  gsap.set(entries.slice(1), { yPercent: 40, y: 80, opacity: 0 });
  const mark = (i: number) => {
    for (const [j, li] of index.entries()) li.classList.toggle("is-on", j === i);
  };
  mark(0);

  const tl = gsap.timeline({ defaults: { ease: "power3.inOut", duration: 1 } });
  entries.forEach((e, i) => {
    if (i === 0) return;
    const prev = entries.slice(0, i);
    tl.addLabel(`e${i}`)
      .to(e, { yPercent: 0, y: 0, opacity: 1 }, `e${i}`)
      .to(
        prev,
        {
          y: (j: number) => -(i - j) * 30,
          scale: (j: number) => 1 - (i - j) * 0.04,
          opacity: (j: number) => (i - j === 1 ? 0.55 : i - j === 2 ? 0.22 : 0),
          duration: 1,
        },
        `e${i}`,
      )
      .to({}, { duration: 0.5 });
  });
  tl.eventCallback("onUpdate", () => {
    let on = 0;
    entries.forEach((_, i) => {
      if (i > 0 && tl.time() >= (tl.labels[`e${i}`] ?? 0) + 0.5) on = i;
    });
    mark(on);
  });

  ScrollTrigger.create({
    trigger: court,
    start: "top 110px",
    end: `+=${entries.length * 520}`,
    pin: true,
    scrub: 0.8,
    animation: tl,
  });

  return () => {
    list.style.gridTemplateAreas = "";
    list.style.alignItems = "";
    list.style.paddingTop = "";
    list.style.minHeight = "";
    list.style.alignContent = "";
    court.style.alignItems = "";
    for (const e of entries) e.style.gridArea = "";
    gsap.set(entries, { clearProps: "all" });
  };
}

/** V · the drawdown marker slides through the bands as you read; bands light as it passes. */
function ladderScene() {
  const ladder = document.querySelector<HTMLElement>("[data-ladder]");
  const mark = ladder?.querySelector<HTMLElement>("[data-ladder-mark]");
  const val = ladder?.querySelector<HTMLElement>("[data-ladder-val]");
  if (!ladder || !mark || !val) return;
  const bands = [...ladder.querySelectorAll<HTMLElement>(".band")];
  const b = DOCTRINE.breakers;
  // each band gets a quarter of the track, so the scale is piecewise
  const stops = [0, b.yellow_drawdown, b.orange_drawdown, b.red_drawdown, b.red_drawdown * 1.2];
  const toPos = (d: number) => {
    for (let i = 0; i < 4; i++) {
      const lo = stops[i] ?? 0;
      const hi = stops[i + 1] ?? 1;
      if (d <= hi) return (i + (d - lo) / (hi - lo)) / 4;
    }
    return 1;
  };
  ladder.classList.add("is-live");
  ScrollTrigger.create({
    trigger: ladder,
    start: "top 78%",
    end: "bottom 40%",
    scrub: 0.6,
    onUpdate: (st) => {
      const d = st.progress * (stops[4] ?? 0.12) * 0.97;
      const p = toPos(d);
      ladder.style.setProperty("--at", `${p * 100}%`);
      ladder.style.setProperty("--rest", String(1 - p));
      val.textContent = `drawdown ${(d * 100).toFixed(1)}%`;
      const band = Math.min(3, Math.floor(p * 4));
      for (const [i, x] of bands.entries()) x.classList.toggle("is-on", i === band);
    },
  });
}

/** VIII · the cockpit window tilts up into view like a screen being opened. */
function windowScene() {
  const frame = document.querySelector<HTMLElement>(".window-frame");
  if (!frame) return;
  gsap.fromTo(
    frame,
    { rotateX: 14, y: 40, scale: 0.94 },
    {
      rotateX: 0,
      y: 0,
      scale: 1,
      ease: "none",
      scrollTrigger: { trigger: frame, start: "top bottom", end: "top 30%", scrub: 0.6 },
    },
  );
}
