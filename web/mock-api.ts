import type { Plugin } from "vite";

/**
 * Dev-only mock of the worker's /api routes (`pnpm web:dev`). Every value here is SYNTHETIC design material,
 * shaped exactly like the real responses; it is never bundled or deployed. `?empty` in the page URL serves the
 * day-one state (no trades, no memory) and `?alert` a lit caution scenario; the choice rides a dev-only cookie.
 */
const H = 3_600_000;

function curve(now: number, start: number, n: number, seed: number): number[][] {
  let v = start;
  return Array.from({ length: n }, (_, i) => {
    v += Math.sin(i * seed) * 0.22 + Math.cos(i * 0.31) * 0.08 + 0.02;
    return [now - (n - i) * H, Math.round(v * 100) / 100];
  });
}

function state(now: number, empty: boolean) {
  return {
    now,
    lastPulseAt: now - 37_000,
    budget: {
      mode: "NORMAL",
      worst: { resource: "neurons_tier2", fraction: 0.42 },
      fractions: {
        worker_requests: 0.06,
        do_duration_gb_s: 0.18,
        neurons_tier1: 0.21,
        neurons_tier2: 0.42,
        d1_rows_read: 0.03,
      },
    },
    journalHead: { seq: 1184, sha: "9f2c4a81d0e3b7c6a5f41e2d9b8c7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b" },
    outboxPending: 0,
    equity: empty ? {} : { PAPER: curve(now, 54, 96, 0.7) },
    regimes: [
      {
        arena: "CRYPTO",
        posture: "NEW_ENTRY_ALLOWED",
        score: 61.4,
        ceiling: null,
        ageMinutes: 74,
        fresh: true,
        source: "batch",
      },
      {
        arena: "EQUITIES",
        posture: "REDUCE_ONLY",
        score: 38.0,
        ceiling: 0.35,
        ageMinutes: 312,
        fresh: true,
        source: "batch",
      },
      {
        arena: "WORLD",
        posture: "INFO",
        score: null,
        ceiling: null,
        ageMinutes: 41,
        fresh: true,
        source: "gdelt",
      },
      {
        arena: "CRYPTO_PROXY",
        posture: "RISK_ON",
        score: null,
        ceiling: null,
        ageMinutes: 2,
        fresh: true,
        source: "baseline-proxy",
      },
    ],
    accounts: [
      {
        account: "PAPER",
        configured: true,
        equityUsd: empty ? 54 : 55.87,
        brokerEquityUsd: empty ? 54 : 56.02,
        modeledCostUsd: empty ? 0 : 0.15,
        hwmUsd: empty ? 54 : 56.31,
        rung: "R1",
        autonomyStop: 2,
        breaker: "GREEN",
        locked: false,
        mode: "NORMAL",
        modeReason: null,
        reconciledAt: now - 38_000,
        lastError: null,
        ordersToday: empty ? 0 : 2,
        positions: empty
          ? []
          : [
              {
                symbol: "SOL/USD",
                qty: "0.0912",
                avgEntry: "184.20",
                stop: "176.80",
                target: "198.60",
                state: "OPEN",
                brokerStop: true,
              },
              {
                symbol: "NVDA",
                qty: "0.0814",
                avgEntry: "212.27",
                stop: "204.10",
                target: "228.00",
                state: "OPEN",
                brokerStop: false,
              },
            ],
        openOrders: empty
          ? []
          : [
              {
                coid: "c54-P-7c8d9e0f-E-1",
                role: "ENTRY",
                symbol: "LINK/USD",
                side: "buy",
                qty: "0.71",
                state: "new",
              },
            ],
      },
      {
        account: "LIVE",
        configured: false,
        equityUsd: null,
        brokerEquityUsd: null,
        modeledCostUsd: 0,
        hwmUsd: null,
        rung: "R1",
        autonomyStop: 0,
        breaker: "GREEN",
        locked: false,
        mode: "DORMANT",
        modeReason: "awaiting ratification",
        reconciledAt: null,
        lastError: null,
        ordersToday: 0,
        positions: [],
        openOrders: [],
      },
    ],
  };
}

const court = (now: number) => [
  {
    ts: now - 2.4 * H,
    payload_json: JSON.stringify({
      sprint: "s1",
      symbol: "SOL/USD",
      win_raw: 0.68,
      win_cal: 0.554,
      bear: 0.31,
      notes: ["targets clipped to 3·ATR·√(h/24)"],
    }),
    symbol: "SOL/USD",
    thesis_summary:
      "SOL reclaims its 20-day high on rising spot volume after the ETF filing headline; the move holds above 182.",
    bear_case_brief:
      "Funding is already positive and the headline may be priced in; a loss of 180 invalidates the breakout and the weekend book is thin.",
    proposed_conviction: 6,
    models_used: JSON.stringify([
      { role: "BULL", provider: "gemini", model: "gemini-3.5-flash" },
      { role: "BEAR", provider: "groq", model: "openai/gpt-oss-120b" },
      { role: "SYNTH", provider: "workers-ai", model: "@cf/cloudflare/clef" },
    ]),
  },
  {
    ts: now - 7.9 * H,
    payload_json: JSON.stringify({
      sprint: "s2",
      symbol: "AAPL",
      win_raw: 0.52,
      win_cal: 0.506,
      bear: 0.64,
      notes: [],
    }),
    symbol: "AAPL",
    thesis_summary: "AAPL momentum burst off a nine-day base with the services headline as catalyst.",
    bear_case_brief: "Earnings on Nov 2 sit inside the hold window; the burst came on 0.87× average volume.",
    proposed_conviction: 3,
    models_used: JSON.stringify([
      { role: "BULL", provider: "groq", model: "qwen/qwen3.8-27b" },
      { role: "BEAR", provider: "nim", model: "nvidia/nemotron-3-ultra-550b-a55b" },
      { role: "SYNTH", provider: "workers-ai", model: "@cf/cloudflare/clef" },
    ]),
  },
];

const rejections = (now: number) => [
  {
    ts: now - 0.4 * H,
    stage: "TIER1",
    symbol: "DOGE/USD",
    arena: "CRYPTO",
    reason_codes: JSON.stringify(["P(material) 0.18 < 0.55"]),
  },
  {
    ts: now - 1.1 * H,
    stage: "SCAR",
    symbol: "ADA/USD",
    arena: "CRYPTO",
    reason_codes: JSON.stringify(["SCAR-001: cool down ADA/USD after 3 losses"]),
  },
  {
    ts: now - 2.0 * H,
    stage: "VALIDATOR",
    symbol: "ETH/USD",
    arena: "CRYPTO",
    reason_codes: JSON.stringify(["correlated with SOL/USD (ρ=0.83 > 0.7)"]),
  },
  {
    ts: now - 7.9 * H,
    stage: "VALIDATOR",
    symbol: "AAPL",
    arena: "EQUITIES",
    reason_codes: JSON.stringify(["earnings on 2026-11-02 (inside the 72 h blackout)"]),
  },
  {
    ts: now - 9.2 * H,
    stage: "TIER2",
    symbol: "TSLA",
    arena: "EQUITIES",
    reason_codes: JSON.stringify(["long_favored 0.41 < 0.72"]),
  },
];

const memory = (now: number, empty: boolean) =>
  empty
    ? { beliefs: [], reputation: {}, scars: [], scarFile: 0, report: null }
    : {
        beliefs: [
          {
            subject: "SOL/USD",
            statement: "SOL/USD: 4 closed trades in 30 days, 3 winners, E[R] +0.62.",
            confidence: 0.41,
          },
          {
            subject: "CRYPTO",
            statement: "CRYPTO_CATALYST_COURT_V1 in CRYPTO: 7 closed trades, 4 winners, E[R] +0.18.",
            confidence: 0.38,
          },
        ],
        reputation: {
          "news:benzinga": { weight: 1.06, signals: 24 },
          "screener:momentum-burst": { weight: 1, signals: 6 },
          filing: { weight: 1, signals: 3 },
        },
        scars: [
          {
            id: "SCAR-001",
            kind: "hard_filter",
            rule: "Cool down ADA/USD: 3 losing trades in 14 days (sum R −2.40).",
            expires: "2026-11-22",
          },
        ],
        scarFile: 1,
        report: {
          produced_at: now - 26 * H,
          payload_json: JSON.stringify({
            card: {
              title: "🧬 Governor report · 2026-W43",
              sections: [
                { name: "Trades", value: "9 closed · CRYPTO_CATALYST_COURT_V1: n=7 E[R]=0.18 PF=1.31" },
                {
                  name: "LIVE gate",
                  value:
                    "✅ Journal hash chain intact (U7): 1184 rows verified\n❌ (b) ≥30 days fully autonomous: 6.2 days\n❌ (b) ≥25 closed PAPER trades: 9\n✅ (b) post-fee expectancy > 0: 0.14\n❌ (b) profit factor > 1.2: 1.13\n✅ (b) zero rail violations: 0\n✅ (b) heartbeat (max daily gap ≤ 10 min): worst 412s over 6 day(s)\n⏳ (b) calibrated Brier < 0.25 (≥20 pairs): 11 pairs",
                },
              ],
              post: true,
            },
          }),
        },
      };

const options = (now: number, empty: boolean) =>
  empty
    ? []
    : [
        {
          trade_id: "t1",
          kind: "CLOSE",
          ts: now - 3 * H,
          strategy: "OPTIONS_BULL_PUT_SPREAD_V1",
          underlying: "QQQ",
          cash: -0.61,
          max_loss_cents: 48020,
          pnl_cents: 6110,
          r: 0.127,
          reason: "TARGET",
        },
        {
          trade_id: "t2",
          kind: "OPEN",
          ts: now - 26 * H,
          strategy: "OPTIONS_PMCC_V1",
          underlying: "AAPL",
          cash: -70.88,
          max_loss_cents: 708820,
          pnl_cents: null,
          r: null,
          reason: null,
        },
        {
          trade_id: "t1",
          kind: "OPEN",
          ts: now - 50 * H,
          strategy: "OPTIONS_BULL_PUT_SPREAD_V1",
          underlying: "QQQ",
          cash: 1.22,
          max_loss_cents: 48020,
          pnl_cents: null,
          r: null,
          reason: null,
        },
      ];

/** Synthetic /api/forecast (ADR-047): a drifting price, a widening amber fan, and a robot plan on BTC. */
function forecast(now: number, symbol: string, empty: boolean) {
  const symbols = [
    "BTC/USD",
    "ETH/USD",
    "SOL/USD",
    "XRP/USD",
    "LINK/USD",
    "AVAX/USD",
    "DOGE/USD",
    "LTC/USD",
    "COIN",
    "MSTR",
    "SPY",
    "QQQ",
    "NVDA",
    "AAPL",
  ];
  const stock = !symbol.includes("/");
  const base = { "BTC/USD": 80_500, "ETH/USD": 2_360, "SOL/USD": 142 }[symbol] ?? 12;
  const hist = Array.from(
    { length: 42 },
    (_, i) => +(base * (1 + 0.02 * Math.sin(i / 6) - 0.0006 * (42 - i))).toPrecision(6),
  );
  const last = hist[hist.length - 1] as number;
  const mid = Array.from({ length: 12 }, (_, i) => +(last * (1 + 0.0012 * (i + 1))).toPrecision(6));
  const spread = (i: number) => last * 0.006 * Math.sqrt(i + 1) * 2.2;
  const hasPlan = symbol === "BTC/USD";
  return {
    symbol,
    symbols: empty ? [] : symbols,
    now,
    kronos: empty
      ? null
      : {
          model: "NeoQuasar/Kronos-base",
          produced_at: now - 75 * 60_000,
          stale: false,
          horizon_hours: 48,
          horizon_label: stock ? "2 trading days" : "48 h",
          candle_hours: stock ? 24 : 4,
          confidence: "LOW",
          about:
            "Kronos-base is a mid-sized (102M-parameter) open-source model trained only on past candlestick charts: it sees no news, fundamentals or order flow. The numbers are shares of 24 randomly sampled 48 h price paths, stretched to match recent volatility. It has not been validated on this account. LOW confidence: treat it as a weak tiebreaker at most, never as a reason to trade, and let any real evidence overrule it.",
          last,
          hist,
          fan: {
            p10: mid.map((v, i) => +(v - spread(i)).toPrecision(6)),
            p50: mid,
            p90: mid.map((v, i) => +(v + spread(i)).toPrecision(6)),
          },
          p_up: 0.71,
          p_win: 0.62,
          exp_ret: 0.0144,
        },
    robot: {
      position: null,
      plan: hasPlan
        ? {
            strategy: "CRYPTO_CATALYST_COURT_V1",
            origin: "COURT",
            created_at: now - 3 * 3_600_000,
            entry_low: last * 0.998,
            entry_high: last * 1.002,
            stop: last * 0.962,
            target: last * 1.045,
            win_prob: 0.39,
            bear_lethality: 0.56,
            thesis: "ETF inflows support a rebound toward the EMA20.",
          }
        : null,
      regime: { posture: "NEW_ENTRY_ALLOWED", score: 60.7 },
    },
  };
}

export function mockApi(): Plugin {
  return {
    name: "cortex-mock-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) {
          // page loads pick the synthetic scenario: /?empty, /?alert, or plain /
          if (req.url === "/" || req.url?.startsWith("/?")) {
            const sc = req.url.includes("alert")
              ? "alert"
              : req.url.includes("empty")
                ? "empty"
                : req.url.includes("live")
                  ? "live"
                  : "normal";
            res.setHeader("set-cookie", `mock=${sc}; Path=/; SameSite=Strict`);
          }
          return next();
        }
        const now = Date.now();
        const sc = /(?:^|;\s*)mock=(\w+)/.exec(req.headers.cookie ?? "")?.[1] ?? "normal";
        const empty = sc === "empty";
        const alert = sc === "alert";
        const live = sc === "live";
        const url = new URL(req.url, "http://dev");
        const send = (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        switch (url.pathname) {
          case "/api/state": {
            const st = state(now, empty);
            if (live) {
              // synthetic: LIVE keys present but still dormant (Stop 0), to exercise the ratify guard
              Object.assign(st.accounts[1] ?? {}, {
                configured: true,
                equityUsd: 54,
                brokerEquityUsd: 54,
                hwmUsd: 54,
                mode: "NORMAL",
                modeReason: null,
                reconciledAt: now - 40_000,
              });
            }
            if (alert) {
              // synthetic caution scenario: YELLOW band, reduce-only, stale equity regime
              Object.assign(st.accounts[0] ?? {}, {
                breaker: "YELLOW",
                equityUsd: 53.94,
                mode: "REDUCE_ONLY",
                modeReason: "equity regime stale (fail closed)",
              });
              Object.assign(st.regimes[1] ?? {}, { fresh: false, ageMinutes: 2100 });
            }
            return send(st);
          }
          case "/api/court":
            return send(empty ? [] : court(now));
          case "/api/rejections":
            return send(empty ? [] : rejections(now));
          case "/api/memory":
            return send(memory(now, empty));
          case "/api/options":
            return send(options(now, empty));
          case "/api/forecast":
            return send(forecast(now, url.searchParams.get("symbol") ?? "BTC/USD", empty));
          case "/api/equity":
            return send(empty ? {} : { PAPER: curve(now, 54, 24 * 14, 0.7) });
          case "/api/command":
            return send({ ok: true, message: "(dev mock) command accepted; nothing was sent to the brain" });
          case "/api/login":
          case "/api/logout":
            return send({ ok: true });
          default:
            return send({ error: "not found" }, 404);
        }
      });
    },
  };
}
