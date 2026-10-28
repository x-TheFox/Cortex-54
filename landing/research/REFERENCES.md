# Landing page references (researched 2026-10-27)

Facts below were fetched from the cited URLs in this session. Section 4 is from general knowledge of the sites and was NOT re-verified live; treat it as ideas only. Not legal advice: have the operator read the licence texts once.

## 1. GSAP 3.15 (Standard no-charge licence)

Verdict: usable on a commercial marketing site, no fee.

- Licence page says the standard licence covers use "by any person or entity" on any website, web app or digital interface, and its FAQ states "Commercial usage is covered under the standard license". Source: https://gsap.com/standard-license
- Prohibited use (the Webflow-competitor clause): you may not use GSAP in a tool that lets users build visual animations without code and that materially assists in creating a solution competing with Webflow's visual animation building. Also no reverse engineering GSAP to build competing products. Source: https://gsap.com/standard-license
  - CORTEX-54 is a trading agent, not a no-code animation builder, so the clause does not apply. Do not ship any user-facing animation-builder feature on GSAP.
- Plugins: all formerly members-only plugins (SplitText, MorphSVG, etc.) are free; ScrollTrigger is part of the same free package. Sources: https://gsap.com/standard-license , https://gsap.com/blog/3-13/ , https://gsap.com/docs/v3/Installation/ ("all the plugins are now freely available on npm").
- Install: `npm install gsap` (public package; the private registry / `gsap-trial` are deprecated). Source: https://gsap.com/docs/v3/Installation/ , https://cdn.jsdelivr.net/npm/gsap-trial@3.13.0/README.md
- Import paths (the `gsap/<Plugin>` pattern is confirmed by the docs' `gsap/DrawSVGPlugin` example; the exact two below come from a third-party summary of the docs, so confirm with a build):
  ```ts
  import { gsap } from "gsap";
  import { ScrollTrigger } from "gsap/ScrollTrigger";
  import { SplitText } from "gsap/SplitText";
  gsap.registerPlugin(ScrollTrigger, SplitText);
  ```
  Sources: https://gsap.com/docs/v3/Installation/ , https://tessl.io/registry/skills/github/greensock/gsap-skills/gsap-plugins
  Always call `registerPlugin` so bundlers do not tree-shake the plugins away (Installation page).
- Attribution: none required by the licence text. The only related clause forbids removing or altering proprietary notices/branding in GSAP products, so keep the licence headers in the library files (a normal Vite build keeps them or you leave GSAP's comments alone). Source: https://gsap.com/standard-license
- Bundling: self-host via npm and Vite; no CDN needed.

## 2. Lenis 1.3.x (MIT)

- Licence MIT (darkroom.engineering). Latest version seen in the README snippets: 1.3.27. Source: https://github.com/darkroomengineering/lenis
- Recommended GSAP integration (from the README):
  ```ts
  import Lenis from "lenis";
  import "lenis/dist/lenis.css";
  const lenis = new Lenis();
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000)); // GSAP gives seconds, Lenis wants ms
  gsap.ticker.lagSmoothing(0);
  ```
  Source: https://github.com/darkroomengineering/lenis
- CSS: `import "lenis/dist/lenis.css"` (or copy `packages/core/lenis.css` from the repo). Same source.
- Reduced motion: Lenis honours `prefers-reduced-motion` by default (smoothing off, programmatic scrolls jump). The README advises against opting out (`respectReducedMotion: false`). `lenis.prefersReducedMotion` is readable so you can also skip your own scrubbed animations. Same source.
  - Plan: if `matchMedia("(prefers-reduced-motion: reduce)").matches`, skip SplitText/scrub timelines and show final states; keep Lenis default behaviour.
- Modal open/close: `lenis.stop()` on open, `lenis.start()` on close. `scrollTo` takes `force` to scroll while stopped. Same source.
- Inner scroll containers (modal body, code panes, iframes' wrappers): add `data-lenis-prevent` (variants `-wheel`, `-touch`, `-vertical`, `-horizontal`), or the `prevent: (node) => node.id === "modal"` option. Same source.
- ScrollTrigger caveat: with Lenis driving the ticker, do not also enable ScrollTrigger's own smooth scroll tools; call `ScrollTrigger.refresh()` after fonts load.

## 3. React Bits

Verdict: licence is MIT + Commons Clause; commercial use on a product site is allowed. Do not use the React code itself in this vanilla build anyway; port ideas.

- The repo badge reads "MIT + Commons Clause" and says "free for personal and commercial use". Source: https://github.com/DavidHDev/react-bits
- Licence text: may be used for commercial purposes "so long as you do not sell, sublicense, or redistribute the components themselves"; tools/sound library cannot be offered as a hosted service; exports from its tools cannot be sold on their own; use "as part of an application, website, or product" is granted. Source: https://raw.githubusercontent.com/DavidHDev/react-bits/main/LICENSE.md
- Practical rule for us: a marketing site that uses an effect is fine. Do not publish a copied component as a library or template. Rewriting the idea in vanilla TS from scratch is the safest route and avoids any attribution question; if code is copied verbatim, keep the licence notice.
- Three effects worth porting (names as on the site; behaviours from the project's descriptions, check https://reactbits.dev for each demo):
  1. Split/Blur text reveal (SplitText, BlurText family): headline words or letters fade up from a soft blur on scroll-in. Port with GSAP SplitText, `autoAlpha`, `y: 12`, `filter: blur(6px)` to 0, stagger ~0.03s, once only. Restrained when limited to H1/H2.
  2. Count-up / rolling numbers (CountUp family): numbers tick to their final value when scrolled into view. Port with a `gsap.to` on a plain object plus `Intl.NumberFormat`, tabular figures, 1.2s `power3.out`. Suits metrics such as "$54" or "8 rules".
  3. Spotlight / glare card (SpotlightCard family): a soft radial highlight follows the pointer across a card. Port with a CSS custom property pair (`--mx`, `--my`) set on `pointermove` and a `radial-gradient` at low opacity in a warm neutral. Disable on touch and under reduced motion.
  Each effect idea is mentioned on https://reactbits.dev (verify names there before citing in public copy).

## 4. Reference sites (ideas only, do not copy; not re-verified live)

| Site | URL | Technique worth studying |
|---|---|---|
| Linear | https://linear.app | Tight type scale and near-monochrome dark UI where product screenshots reveal with small opacity and translate steps, never bouncing. |
| Stripe (Sessions / Press) | https://stripe.com/sessions | Large editorial headlines with measured section transitions and generous whitespace; motion is used to explain structure, not decorate. |
| Vercel (Ship) | https://vercel.com/ship | Pinned scroll sections where one idea is on screen at a time, with a thin grid and mono labels carrying the technical tone. |
| Apple product pages | https://www.apple.com/macbook-pro/ | Scroll-scrubbed product narrative: sticky stage, one claim per viewport, copy fading in and out against a continuous visual. |
| Family (Rauno / Benji Taylor) | https://family.co | Small, physical interface details (springs, blur, easing) that make the product feel crafted; read Rauno's writing at https://rauno.me for the philosophy. |
| Arc (The Browser Company) | https://arc.net | Warm editorial layout with oversized type and playful but slow reveals; copy tone matters as much as motion. |

## 5. SplitText accessibility

Yes. Since v3.13.0 SplitText has an `aria` option (values `"auto"`, `"hidden"`, `"none"`; default `"auto"`).
- `"auto"`: adds `aria-label` to the split element filled from its text, and hides the created line/word/char elements from screen readers (`aria-hidden`). Nested elements such as links are not preserved in the label.
- `"hidden"`: hides the split element and all its children from assistive tech.
- `"none"`: adds nothing. Use this when the text contains links, and supply a screen-reader-only duplicate of the text yourself.
Sources: https://gsap.com/docs/v3/Plugins/SplitText/ , https://gsap.com/blog/3-13/
Other 3.13 additions: responsive re-splitting (`autoSplit`) and masking.
Recommendation: use `aria: "auto"` for plain headings; for headings containing links or `<em>` use `aria: "none"` plus a visually hidden copy.
Caveat: splitting before web fonts load gives wrong line breaks; split inside `document.fonts.ready.then(...)` and use `autoSplit: true` with `onSplit` for resize.

## Open questions for the operator
- Confirm ScrollTrigger and SplitText import paths with a trial `vite build` (documentation pages fetched here did not print them directly).
- CSP: Lenis and GSAP inject no inline `<script>`; GSAP sets inline `style` attributes via the CSSOM, which strict `style-src` without `'unsafe-inline'` still permits (CSSOM writes are not blocked). Verify in the browser console once built.
