import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { CONSTITUTION, CONSTITUTION_SHA256, DOCTRINE, DOCTRINE_SHA256 } from "../src/generated/config.ts";
import { CHECKOUT_URL, ORDERS_URL, PLANS, TRIAL_DAYS } from "./checkout.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The landing page (ADR-084). Static, vanilla TypeScript. Every rule and limit it prints comes from config/ through
 * src/generated/config.ts at build time, so the page cannot drift from what the brain enforces. A `%%TOKEN%%` left in
 * the HTML fails the build.
 */

const pct = (x: number) => `${+(x * 100).toFixed(2)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TITLES: Record<string, string> = {
  U1: "No contract, no order.",
  U2: "Models never size.",
  U3: "Hard caps. Cash only.",
  U4: "Every position has an exit.",
  U5: "The kill switch is sacred.",
  U6: "Fail closed.",
  U7: "The journal can't be rewritten.",
  U8: "Changing itself needs your approval.",
};
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

function constitutionHtml(): string {
  const inverse = CONSTITUTION.allowed.inverse_etfs_1x.join(", ");
  return CONSTITUTION.untouchables
    .map((u, i) => {
      const rule = u.rule
        .replace(/ \(ADR-\d+\)/g, "")
        .replace("the 1x inverse ETFs listed in allowed.inverse_etfs_1x", `the 1x inverse ETFs (${inverse})`);
      return `<li class="article" data-reveal>
  <span class="article-num" aria-hidden="true">${ROMAN[i]}</span>
  <div class="article-body">
    <h3 class="article-title"><span class="sr-only">Article ${i + 1}: </span>${esc(TITLES[u.id] ?? u.name)}</h3>
    <p class="article-text">${esc(rule)}</p>
    <code class="article-id">${esc(u.id)} · ${esc(u.name)}</code>
  </div>
</li>`;
    })
    .join("\n");
}

const money = (x: number) => `$${x.toLocaleString("en-US")}`;

/** The rung ladder (docs/RISK_DOCTRINE.md §3): every limit is a share of equity, tightening as equity grows. */
function rungRows(): string {
  const names = ["R1", "R2", "R3", "R4", "R5"] as const;
  return names
    .map((n) => {
      const r = DOCTRINE.rungs[n];
      const range =
        r.equity_max === null
          ? `${money(r.equity_min)} and up · no ceiling`
          : r.equity_min === 0
            ? `under ${money(r.equity_max)}`
            : `${money(r.equity_min)} – ${money(r.equity_max)}`;
      return `<tr><th scope="row">${n}</th><td>${range}</td><td>${pct(r.per_trade_risk)}</td><td>${pct(
        r.max_position_notional,
      )}</td><td>${r.max_positions}</td><td>${pct(r.total_heat)}</td></tr>`;
    })
    .join("\n");
}

function checkout(): { href: string; note: string } {
  const url = CHECKOUT_URL.trim();
  if (url && !/^https:\/\//.test(url)) throw new Error("landing: CHECKOUT_URL must be an https:// link");
  if (/github\.com/i.test(url)) throw new Error("landing: checkout must not point at the source repository");
  return url
    ? { href: esc(url), note: "" }
    : {
        href: "#get",
        note: '<p class="checkout-note" data-checkout-note>Checkout opens soon. The live demo works today.</p>',
      };
}

function tokens(): Record<string, string> {
  const r1 = DOCTRINE.rungs.R1;
  const start = DOCTRINE.accounts.PAPER.starting_equity_usd;
  const b = DOCTRINE.breakers;
  const hl = CONSTITUTION.hard_limits;
  const f = DOCTRINE.funnel;
  const co = checkout();
  return {
    CHECKOUT_HREF: co.href,
    CHECKOUT_NOTE: co.note,
    PRICE_MONTHLY: PLANS.monthly.price,
    PRICE_YEARLY: PLANS.yearly.price,
    CHECKOUT_MONTHLY: esc(PLANS.monthly.url),
    CHECKOUT_YEARLY: esc(PLANS.yearly.url),
    CHECKOUT_DEMO: esc(PLANS.demo.url),
    TRIAL_DAYS: String(TRIAL_DAYS),
    ORDERS_URL: esc(ORDERS_URL),
    RUNG_ROWS: rungRows(),
    CONSTITUTION_ARTICLES: constitutionHtml(),
    CONST_SHA: CONSTITUTION_SHA256.slice(0, 12),
    DOCT_SHA: DOCTRINE_SHA256.slice(0, 12),
    START_USD: `$${start}`,
    R1_RISK_PCT: pct(r1.per_trade_risk),
    R1_RISK_USD: usd(start * r1.per_trade_risk),
    R1_NOTIONAL_PCT: pct(r1.max_position_notional),
    R1_NOTIONAL_USD: usd(start * r1.max_position_notional),
    R1_HEAT_PCT: pct(r1.total_heat),
    R1_MAX_POS: String(r1.max_positions),
    HL_RISK: pct(hl.max_per_trade_risk_pct),
    HL_NOTIONAL: pct(hl.max_position_notional_pct),
    HL_DAILY: pct(hl.max_daily_loss_pct),
    HL_DD: pct(hl.red_breaker_max_drawdown_pct),
    HL_ORDERS: String(hl.max_orders_per_day_per_account),
    HL_STALE: `${hl.max_quote_staleness_seconds} s`,
    HL_BUDGET: pct(hl.free_tier_hard_stop_fraction),
    B_YELLOW: pct(b.yellow_drawdown),
    B_ORANGE: pct(b.orange_drawdown),
    B_RED: pct(b.red_drawdown),
    B_RED_DAILY: pct(b.red_daily_loss),
    B_STOPOUTS: String(b.red_consecutive_stopouts_24h),
    B_YELLOW_X: `×${b.multipliers.YELLOW.toFixed(1)}`,
    B_GREEN_X: `×${b.multipliers.GREEN.toFixed(1)}`,
    B_PAPER_UNLOCK: `${b.paper_auto_unlock_hours} h`,
    T0_INTAKE: String(DOCTRINE.universe.max_open_intake_per_day),
    T1_BAR: String(f.tier1.escalate_threshold),
    T1_ESC: String(f.tier1.min_escalate_score),
    T1_PER_PULSE: String(f.tier1.max_batches_per_pulse),
    T2_BAR: String(f.tier2.pass_threshold),
    T2_PER_DAY: String(f.tier2.max_per_day),
    T2_QUALITY: String(f.tier3.min_structural_score),
    T3_PER_DAY: String(f.tier3.max_sprints_per_day),
    CAL_N: String(f.calibration.min_outcomes_before_trusting),
    MIN_STOP_ATR: `${DOCTRINE.sizing.min_stop_atr_multiple}`,
    HURDLE: `${DOCTRINE.fees.hurdle_multiple}`,
  };
}

function fromConfig(): Plugin {
  return {
    name: "cortex-config-tokens",
    transformIndexHtml(html) {
      const t = tokens();
      const out = html.replace(/%%([A-Z0-9_]+)%%/g, (m, k: string) => t[k] ?? m);
      const left = out.match(/%%[A-Z0-9_]+%%/g);
      if (left) throw new Error(`landing: unknown config tokens ${left.join(", ")}`);
      return out;
    },
  };
}

/** Strict CSP as a meta tag in the built page only (the dev server injects inline HMR code). */
function csp(): Plugin {
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "cortex-landing-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<!--CSP-->",
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />\n    <meta name="referrer" content="no-referrer" />`,
      );
    },
  };
}

const HUB_PROXY = {
  target: "https://hub.getsavant.pro",
  changeOrigin: true,
  rewrite: (p: string) => p.replace(/^\/hub/, ""),
};

export default defineConfig({
  root,
  base: "./",
  plugins: [fromConfig(), csp()],
  // /hub mirrors the vercel.json rewrite to the community hub (ADR-095), so the community pages work locally too
  server: { port: 5175, strictPort: true, proxy: { "/hub": HUB_PROXY } },
  preview: { port: 5176, strictPort: true, proxy: { "/hub": HUB_PROXY } },
  build: {
    outDir: fileURLToPath(new URL("../landing-dist", import.meta.url)),
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        welcome: fileURLToPath(new URL("./welcome/index.html", import.meta.url)),
        notfound: fileURLToPath(new URL("./404.html", import.meta.url)),
        account: fileURLToPath(new URL("./account/index.html", import.meta.url)),
        activate: fileURLToPath(new URL("./activate/index.html", import.meta.url)),
        community: fileURLToPath(new URL("./community/index.html", import.meta.url)),
        communityAgent: fileURLToPath(new URL("./community/agent/index.html", import.meta.url)),
      },
    },
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
