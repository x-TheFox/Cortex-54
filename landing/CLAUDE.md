# landing/ — the Savant product page (ADR-084, ADR-090)

Read the root `CLAUDE.md` first (it is the law), then `CORTEX_LEDGER.md` (§14 is the claims law, §18 is this page).
After a compaction: re-read this file, the task list below and ledger §18 before touching anything.

## What it is
A static, vanilla-TypeScript page whose one job is to sell Savant. No framework. Built by `landing/vite.config.ts`.

```bash
pnpm landing:dev       # http://localhost:5175 (the demo iframe needs a build: use preview for that)
pnpm landing:build     # landing-dist/ + the demo cockpit in landing-dist/demo/ (scripts/build-landing.ts)
pnpm landing:preview   # http://localhost:5176 — serves landing-dist/ (launch.json profile "landing")
```
Deployed to https://getsavant.pro on Vercel with `pnpm deploy:landing` (ADR-090; project `savant`). `landing/vercel.json`
travels into `landing-dist/` and carries the security headers and the `/download/*` and `/updates/*` redirects. The demo
cockpit lives at `/demo/`, the post-purchase page at `/welcome/`, the legal set at `/legal/`.

## Direction (decided, keep it)
- **A public record on paper.** Warm paper `#efebe3`, ink `#15130f`, Newsreader (display, italic for the counterpoint
  line), IBM Plex Sans (text), IBM Plex Mono (labels, figures). Two dark "chambers": the hearing and the record.
- **Narrative = due process.** One idea moves through I Intake → II Hearing → III Sentencing (sizer) → IV Constitution →
  V When it's wrong (breakers) → VI Graduation → VII Record → VIII Yours → Risks. The product's own court-card voice
  ("Matter before the court", "Clef 27B, presiding", "RULING") is the copy source.
- **Not ECAM.** The cockpit's Airbus look appears only inside the demo dialog and the screenshot. Borrowed principles:
  fixed colour meanings (`--pass` green allowed, `--caution` ochre smaller, `--stop` orange exits only, `--veto` red no),
  quiet until it matters, honest labels.
- **Motion is procedural, never bouncy:** strike (intake), stack (hearing), slide (drawdown), tilt (cockpit window).
  expo/power easing, no springs. Every scene's end state equals the static page.

## Selling rules (operator, 2026-10-27)
- **Closed-source product.** Never link to the GitHub repository, its releases or source files from the page or
  `llms.txt` (`test/landing.test.ts` enforces it). Visible copy names functions, not repo paths.
- **Every buy button is `href="%%CHECKOUT_HREF%%" data-checkout`.** The link lives in `landing/checkout.ts`
  (`CHECKOUT_URL`). Empty → buttons go to `#get` with "Checkout opens soon". The operator is preparing Whop; when the
  Whop checkout URL arrives, paste it there, rebuild, and check whether Whop's embed (if used instead of a link) needs
  CSP changes in `csp()` (`frame-src`/`script-src` for whop.com) — a plain link needs none.
- **Any account size.** $54 is the reference account ("Why 54?"), never the product's limit. The sizer's account
  switch runs $10…$1B through `rungForEquity()`; a $10 crypto account honestly can't trade (the broker's $10 crypto
  minimum vs a 35% position cap) while $10 in stocks can — keep that honesty.

## Rules for editing
- **Never type an engine number by hand.** Add a token in `vite.config.ts` → `tokens()` and use `%%TOKEN%%` in
  `index.html`; unknown tokens fail the build. Constitution articles render from `config/constitution.json`.
- The sizer exhibit imports `src/risk/PositionSizer.ts`; the chain exhibit imports `src/journal/Journal.ts`. Keep them
  imports, not copies — "the shipped code, not a copy" is a claim on the page.
- `test/landing.test.ts` guards forbidden claims (notarized, prices, Docker, hub, testimonials, approve-trades). If you
  need to add a claim, find its anchor in the ledger first.
- Motion lives only in `src/motion.ts` (lazy chunk, ~52 KB gzip). Initial JS ~6 KB gzip, CSS ~9 KB gzip. Reduced
  motion never loads the chunk. Pinned scenes only at ≥1081×720 (`DESKTOP` in motion.ts).
- CSP is a meta tag injected at build only (`csp()` plugin). Nothing from CDNs. GSAP sets inline styles through the
  CSSOM, which `style-src 'self'` allows.
- `cockpit.webp` is a screenshot of the demo build at 1600×1000 (amber DEMO banner visible). Re-take it when the cockpit
  changes noticeably.

## Verified (2026-10-27)
- Lighthouse mobile: Best Practices 100, Accessibility 97 → contrast/label fixes applied after, SEO 92 → robots.txt added.
- LCP 2.07 s on Slow 4G + 4× CPU (phone), CLS 0.01. The hero lede must not fade in (it is the phone LCP element).
- Sizer reproduces docs/RISK_DOCTRINE.md worked example: $12.23 notional, $0.54 at risk.
- Demo dialog: opens from every `[data-demo-open]`, `#demo` deep link, scenarios normal/alert/empty, Esc/close restore.

## Task list
- [x] Ledger read; directions explored; "due process / public record" chosen
- [x] Build wiring (vite config, tsconfig, scripts, gitignore, launch.json, biome override for the stylesheet)
- [x] Sections, motion, demo dialog, real sizer + journal hash exhibits
- [x] Desktop / phone / reduced-motion / Lighthouse / LCP checks
- [x] ADR-084, NOTICE.md, CLAUDE.md, DISTRIBUTION.md, release.yml Pages job, test/landing.test.ts, ledger §18
- [x] Any-account-size message; sizer account/market switches; rung ladder from config
- [x] GitHub/release links removed; checkout placeholder (`landing/checkout.ts`)
- [x] Whop checkout and pricing (prices from `landing/checkout.ts`), sign-in link to Whop orders, legal footer
- [x] getsavant.pro on Vercel; Open Graph image; sitemap; 404; welcome page
- [ ] Later: re-take `cockpit.webp` when the cockpit changes; consider a recorded hearing replay once real transcripts exist
