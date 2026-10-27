import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { AlpacaClient, AlpacaMarketData } from "../src/broker/AlpacaClient.ts";
import type { BrokerApi, MarketDataApi } from "../src/broker/types.ts";
import { type ClefApi, WorkersAiClef } from "../src/clef/ClefClient.ts";
import { type ClairicApi, WorkersAiClairic } from "../src/clef/clairic.ts";
import { CloudflareRestAi, ShimClairic, ShimClef } from "../src/clef/portable.ts";
import { Brain, type PulseReport } from "../src/cortex/Brain.ts";
import { HOT_SCHEMA, HOT_SCHEMA_VERSION } from "../src/cortex/hot-schema.ts";
import { getKV, setKV } from "../src/cortex/store.ts";
import type { LlmRouter } from "../src/court/llm.ts";
import { buildPool, costUsd, type PoolReport, poolRouter } from "../src/court/pool.ts";
import { buildProviders } from "../src/court/providers.ts";
import {
  type ChannelKey,
  type DiscordMessage,
  DiscordNotifier,
  type Notifier,
  parseChannels,
} from "../src/discord/notifier.ts";
import {
  CALIBRATION,
  CONSTITUTION,
  CONSTITUTION_SHA256,
  DOCTRINE,
  DOCTRINE_SHA256,
  SCAR_TISSUE,
} from "../src/generated/config.ts";
import { hubFromEnv } from "../src/hub/client.ts";
import { verifySignedBody } from "../src/lib/hmac.ts";
import type { AccountId } from "../src/lib/ids.ts";
import { InboxNotifier, readFeed } from "../src/notify/inbox.ts";
import { ntfyUrl, PushNotifier } from "../src/notify/push.ts";
import { handleWeb, loginLink, type WebBrain, type WebSettings } from "../src/web/api.ts";
import { pill, pillAuthorized, swiftbar } from "../src/web/pill.ts";
import { snapshotDb } from "./backup.ts";
import type { LocalConfig } from "./config.ts";
import { runtimeChecks } from "./health.ts";
import { LocalJobs } from "./jobs.ts";
import { entriesBlocked, readLicense } from "./license.ts";
import { loadLocalScar, mergeScar } from "./memory.ts";
import { SimBroker } from "./simbroker.ts";
import { fileD1, fileSql, type LocalD1 } from "./store.ts";

/**
 * cortexd: the whole CORTEX-54 brain on one machine (ADR-064). Same Brain, same doctrine and constitution, same
 * journal schema; the Durable Object's alarm becomes a timer, D1 becomes a SQLite file, GitHub Actions become local
 * subprocesses, and the router becomes a small HTTP server bound to localhost. Two modes:
 *   demo  – a keyless simulated broker on live public crypto prices (nothing to sign up for);
 *   paper – the user's own Alpaca paper account (CORTEX needs it exclusively: don't share it with a cloud brain).
 * A live account can be connected too (ADR-083); it stays at Stop 0 until the user ratifies LIVE autonomy (U8).
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const EXPORT_TABLES = new Set([
  "journal",
  "decision_contracts",
  "fills",
  "orders_log",
  "rejections",
  "rejection_grades",
  "triage_log",
  "llm_calls",
  "postmortems",
  "options_shadow",
]);

/** Prints to the console (and the daemon log); Discord and phone pushes are added when their keys exist. */
export class ConsoleNotifier implements Notifier {
  readonly recent: { at: number; channel: ChannelKey; text: string }[] = [];
  constructor(private readonly quiet = false) {}
  async post(channel: ChannelKey, msg: DiscordMessage): Promise<string | null> {
    const e = msg.embeds?.at(-1) ?? msg.embeds?.[0];
    const text = (e?.title ?? msg.content ?? "").replace(/\*\*/g, "").slice(0, 200);
    this.recent.push({ at: Date.now(), channel, text });
    if (this.recent.length > 200) this.recent.shift();
    if (!this.quiet && channel !== "command_center") console.log(`[${channel}] ${text}`);
    return null;
  }
  async edit(): Promise<boolean> {
    return false;
  }
}

/** Fan out to several notifiers (console + Discord + ntfy). */
class Multi implements Notifier {
  constructor(private readonly all: Notifier[]) {}
  async post(c: ChannelKey, m: DiscordMessage): Promise<string | null> {
    const ids = await Promise.all(this.all.map((n) => n.post(c, m).catch(() => null)));
    return ids.find((x) => x !== null) ?? null;
  }
  async edit(c: ChannelKey, id: string, m: DiscordMessage): Promise<boolean> {
    return (await Promise.all(this.all.map((n) => n.edit(c, id, m).catch(() => false)))).some(Boolean);
  }
}

/** News needs keys; in keyless demo mode intake just sees no news instead of failing every pulse. */
function keylessNews(m: MarketDataApi): MarketDataApi {
  return {
    news: async () => [],
    cryptoQuotes: (s) => m.cryptoQuotes(s),
    stockQuotes: async () => ({}),
    cryptoDailyBars: (s, d, n) => m.cryptoDailyBars(s, d, n),
    stockDailyBars: async () => ({}),
    ...(m.hourlyBars
      ? {
          hourlyBars: (s: string, since: number) =>
            s.includes("/")
              ? (m.hourlyBars as NonNullable<MarketDataApi["hourlyBars"]>)(s, since)
              : Promise.resolve([]),
        }
      : {}),
  };
}

export interface LocalOptions {
  home: string;
  root: string; // repo / app resources root (config, migrations, public, research)
  cfg: LocalConfig;
  now?: () => number;
  /** tests: inject fakes instead of real network clients */
  /** ADR-071: the settings page's backend (the CLI provides it, with a reload that applies saved settings) */
  settings?: WebSettings;
  overrides?: {
    broker?: BrokerApi;
    /** tests: a fake live broker (never a real one) */
    liveBroker?: BrokerApi;
    market?: MarketDataApi;
    clef?: ClefApi | null;
    quiet?: boolean;
    http?: (u: string, i?: RequestInit) => Promise<Response>;
  };
}

export class LocalCortex {
  readonly brain: Brain;
  readonly sql: ReturnType<typeof fileSql>;
  readonly d1: LocalD1;
  readonly jobs: LocalJobs;
  readonly console: ConsoleNotifier;
  private server: Server | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  lastReport: PulseReport | null = null;

  constructor(private readonly o: LocalOptions) {
    const { cfg, home, root } = o;
    const now = o.now ?? (() => Date.now());
    const k = cfg.keys;
    this.sql = fileSql(join(home, "hot.sqlite"));
    for (const s of HOT_SCHEMA) this.sql.exec(s);
    this.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('hot_schema_version', ?)",
      String(HOT_SCHEMA_VERSION),
    );
    this.d1 = fileD1(join(home, "journal.sqlite"), join(root, "migrations"));
    const alpacaKey =
      k.ALPACA_PAPER_KEY_ID && k.ALPACA_PAPER_SECRET
        ? { keyId: k.ALPACA_PAPER_KEY_ID, secret: k.ALPACA_PAPER_SECRET }
        : null;
    // ADR-083: the user's live account. It connects at Stop 0 (dormant): no order is placed for it until the user
    // ratifies LIVE autonomy twice on a fresh sign-in. Market data prefers the paper key.
    const liveKey =
      k.ALPACA_LIVE_KEY_ID && k.ALPACA_LIVE_SECRET
        ? { keyId: k.ALPACA_LIVE_KEY_ID, secret: k.ALPACA_LIVE_SECRET }
        : null;
    const dataKey = alpacaKey ?? liveKey;
    const noGuard = () => undefined;
    const rawMarket =
      o.overrides?.market ?? new AlpacaMarketData(dataKey ?? { keyId: "", secret: "" }, noGuard);
    const market = dataKey || o.overrides?.market ? rawMarket : keylessNews(rawMarket);
    let broker: BrokerApi;
    if (o.overrides?.broker) broker = o.overrides.broker;
    else if (cfg.mode === "paper") {
      if (!alpacaKey)
        throw new Error("paper mode needs ALPACA_PAPER_KEY_ID and ALPACA_PAPER_SECRET (or use demo mode)");
      broker = new AlpacaClient(
        DOCTRINE.accounts.PAPER?.alpaca_base_url ?? "https://paper-api.alpaca.markets",
        alpacaKey,
        noGuard,
      );
    } else broker = new SimBroker(this.sql, market, cfg.starting_cash, now);
    const live: BrokerApi | null =
      o.overrides?.liveBroker ??
      (liveKey
        ? new AlpacaClient(
            DOCTRINE.accounts.LIVE?.alpaca_base_url ?? "https://api.alpaca.markets",
            liveKey,
            noGuard,
          )
        : null);

    // ADR-072: built-in free providers + the user's endpoints, as one pool in round robin
    const built = buildPool(
      {
        ...DOCTRINE,
        universe: { ...DOCTRINE.universe, enabled: DOCTRINE.universe.enabled && Boolean(alpacaKey) },
      },
      buildProviders(k),
      cfg.llm,
    );
    // ADR-075: the user's court capacity (more hearings per day for pools with paid models)
    const cap = cfg.court.max_per_day;
    const d = cap
      ? {
          ...built.d,
          funnel: {
            ...built.d.funnel,
            tier3: { ...built.d.funnel.tier3, max_sprints_per_day: cap },
            research: {
              ...built.d.funnel.research,
              max_per_day: Math.max(built.d.funnel.research.max_per_day, cap + 4),
            },
          },
        }
      : built.d;
    this.pool = built.report;
    this.pricing = built.pricing;
    const { clef, clairic } = this.clefFor(cfg, built);
    this.console = new ConsoleNotifier(o.overrides?.quiet ?? false);
    const notifiers: Notifier[] = [this.console];
    if (k.DISCORD_BOT_TOKEN)
      notifiers.push(new DiscordNotifier(k.DISCORD_BOT_TOKEN, parseChannels(k.DISCORD_CHANNELS), noGuard));
    let notifier: Notifier = notifiers.length === 1 ? this.console : new Multi(notifiers);
    const push = ntfyUrl(k.NTFY_TOPIC, k.NTFY_URL);
    if (push) notifier = new PushNotifier(notifier, push, noGuard);
    // ADR-071: the app's feed gets every card, whatever else is configured
    notifier = new InboxNotifier(this.sql, notifier, now);

    this.router = built.report.entries.length ? poolRouter(built, cfg.llm.prefs) : null;
    this.jobs = new LocalJobs({ researchDir: join(root, "research"), home, url: this.url(), cfg });
    this.brain = new Brain({
      sql: this.sql,
      d,
      c: CONSTITUTION,
      brokers: { PAPER: broker, ...(live ? { LIVE: live } : {}) },
      market,
      notifier,
      d1: this.d1,
      // the local kill switch; on a licensed build, paper mode without a valid licence holds entries the same way
      // (exits and stops keep working: ADR-077)
      readKillFlag: async () =>
        existsSync(join(home, "KILLED")) ||
        ((cfg.mode === "paper" || Boolean(liveKey)) && entriesBlocked(readLicense(home))),
      now,
      clef: o.overrides?.clef !== undefined ? o.overrides.clef : clef,
      clairic,
      llm: this.router,
      calibration: CALIBRATION,
      scar: mergeScar(SCAR_TISSUE, loadLocalScar(home)), // + memory packs the operator applied (ADR-068)
      dispatcher: cfg.research.enabled ? this.jobs : null,
      http: o.overrides?.http ?? (o.overrides?.market ? null : (u, i) => fetch(u, i)),
      hub: hubFromEnv(k),
      // ADR-081: on the user's computer only their own Cloudflare AI allowance is a real limit (if they use it)
      budgetScope: this.clefMode === "cloudflare" ? "workers_ai" : "none",
      adoptAccountSize: true,
    });
    this.broker = broker;
    this.liveBroker = live;
    this.brain.init({
      constitution_sha256: CONSTITUTION_SHA256,
      doctrine_sha256: DOCTRINE_SHA256,
      hot_schema_version: HOT_SCHEMA_VERSION,
      accounts: live ? ["PAPER", "LIVE"] : ["PAPER"],
      host: "local",
      mode: cfg.mode,
    });
  }

  url(): string {
    return `http://${this.o.cfg.bind === "0.0.0.0" ? "127.0.0.1" : this.o.cfg.bind}:${this.o.cfg.port}`;
  }

  /** see resolveClef */
  clefMode = "off";
  private router: LlmRouter | null = null;
  private broker: BrokerApi | null = null;
  private liveBroker: BrokerApi | null = null;

  /**
   * ADR-081: "make it cash-only" — Alpaca's paper accounts allow margin by default, which the constitution forbids,
   * so the brain holds them in reduce-only. This caps borrowing at 1x and turns shorting off at the broker (it only
   * ever tightens), then reports what the broker now says.
   */
  async makeCashOnly(account: "PAPER" | "LIVE" = "PAPER"): Promise<{ ok: boolean; message: string }> {
    const b = account === "LIVE" ? this.liveBroker : this.broker;
    if (!b?.configure || !b.configuration)
      return { ok: false, message: "Only a paper account has this setting." };
    await b.configure({ max_margin_multiplier: "1", no_shorting: true });
    const [cfg, acct] = await Promise.all([b.configuration(), b.account()]);
    this.sql.exec("DELETE FROM settings WHERE key = ?", `broker_cash_only:${account}`);
    const capped = Number(cfg.max_margin_multiplier) === 1;
    return capped
      ? {
          ok: true,
          message: `Done: borrowing is capped at 1x and shorting is off at Alpaca (the account reports multiplier ${acct.multiplier ?? "?"}). New trades resume at the next pulse.`,
        }
      : {
          ok: false,
          message:
            "Alpaca didn't keep the change. Reset the paper account in Alpaca's dashboard and try again.",
        };
  }
  private pricing: Record<string, { in: number; out: number; cap?: number }> = {};

  /** ADR-075 cost meter: today's tokens and USD for every priced endpoint. */
  spend(): { provider: string; input: number; output: number; usd: number; cap: number | null }[] {
    const g = this.router?.gate;
    return Object.entries(this.pricing).map(([p, price]) => {
      // the router counts a same-model bear alias with its endpoint
      const { input, output } = g?.tokensToday?.(p) ?? { input: 0, output: 0 };
      return { provider: p, input, output, usd: costUsd(price, input, output), cap: price.cap ?? null };
    });
  }

  /** ADR-076: consistent copies of the databases for a backup, taken while the brain runs. */
  snapshot(): Record<string, Buffer> {
    const out: Record<string, Buffer> = {
      "hot.sqlite": snapshotDb(this.sql.db),
      "journal.sqlite": snapshotDb(this.d1.db),
    };
    const scar = join(this.o.home, "scar-tissue.local.json");
    if (existsSync(scar)) out["scar-tissue.local.json"] = readFileSync(scar);
    return out;
  }

  /** ADR-076: this computer's address on the local network (for phone pairing), or null. */
  lanUrl(): string | null {
    for (const list of Object.values(networkInterfaces()))
      for (const a of list ?? [])
        if (
          a.family === "IPv4" &&
          !a.internal &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)
        )
          return `http://${a.address}:${this.o.cfg.port}`;
    return null;
  }

  async pairLink(): Promise<string | null> {
    const base = this.lanUrl();
    return base ? loginLink({ WEB_SESSION_SECRET: this.o.cfg.secrets.web_session }, base) : null;
  }

  /** ADR-076: the one-line problem the tray shows (null when all is well). */
  problem(): string | null {
    if (existsSync(join(this.o.home, "KILLED"))) return "Kill switch is on: no new entries";
    const lic = readLicense(this.o.home);
    if (this.o.cfg.mode === "paper" && entriesBlocked(lic) && lic.required && !lic.ok)
      return `Licence: ${lic.reason} No new trades until it's fixed; open positions keep their stops.`;
    if (this.pool?.notes.some((n) => n.level === "block")) return "The court needs AI models (Settings)";
    const bad = runtimeChecks(this.health() as Parameters<typeof runtimeChecks>[0]).find((c) => !c.ok);
    return bad ? `${bad.name}: ${bad.detail}` : null;
  }

  /** what the settings page shows about the model pool */
  pool: PoolReport | null = null;

  private clefFor(
    cfg: LocalConfig,
    built: ReturnType<typeof buildPool>,
  ): { clef: ClefApi | null; clairic: ClairicApi | null } {
    const r = resolveClef(cfg, built);
    this.clefMode = r.label;
    return { clef: r.clef, clairic: r.clairic };
  }

  /** One pulse (also what the timer runs). */
  async pulse(): Promise<PulseReport> {
    const run = this.brain.pulse();
    this.inflight = run.then(
      () => undefined,
      () => undefined,
    );
    const r = await run;
    this.lastReport = r;
    return r;
  }
  private inflight: Promise<void> = Promise.resolve();

  private schedule(seconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), seconds * 1000);
  }

  private async tick(): Promise<void> {
    let next = DOCTRINE.cadence.pulse_seconds_exposed;
    try {
      next = (await this.pulse()).nextPulseSeconds;
      setKV(this.sql, "pulse_error_streak", "0", Date.now());
    } catch (e) {
      const n = Number(getKV(this.sql, "pulse_error_streak") ?? 0) + 1;
      setKV(this.sql, "pulse_error_streak", String(n), Date.now());
      next = Math.min(
        DOCTRINE.cadence.pulse_seconds_exposed * 2 ** Math.min(n, 6),
        DOCTRINE.cadence.pulse_seconds_flat,
      );
      console.error(`[pulse] error (streak ${n}): ${String(e).slice(0, 300)}`);
    } finally {
      this.schedule(next);
    }
  }

  async start(): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.server = createServer((req, resp) => void this.serve(req, resp));
      this.server.once("error", rej);
      // ADR-076: phone access listens on the local network too; otherwise only where config says (localhost)
      this.server.listen(this.o.cfg.port, this.o.cfg.lan.enabled ? "0.0.0.0" : this.o.cfg.bind, () => res());
    });
    this.schedule(1);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight; // never close the databases under a running pulse
    await new Promise<void>((res) => {
      if (!this.server) return res();
      this.server.close(() => res());
      this.server.closeAllConnections(); // browsers keep connections alive; a reload must not wait for them
    });
    await this.brain.flushJournal().catch(() => undefined);
    try {
      this.sql.db.close();
      this.d1.db.close();
    } catch {
      /* already closed */
    }
  }

  async loginLink(): Promise<string | null> {
    return loginLink({ WEB_SESSION_SECRET: this.o.cfg.secrets.web_session }, this.url());
  }

  health(): Record<string, unknown> {
    const last = getKV(this.sql, "last_pulse_at");
    return {
      name: "CORTEX-54 local",
      mode: this.o.cfg.mode,
      now: Date.now(),
      last_pulse_at: last === null ? null : Number(last),
      constitution_sha256: CONSTITUTION_SHA256,
      doctrine_sha256: DOCTRINE_SHA256,
      hot_schema_version: HOT_SCHEMA_VERSION,
      policy_violations: this.brain.policyViolations(),
      slo: this.brain.slo(),
      jobs: { running: this.jobs.active(), recent: this.jobs.log.slice(-10) },
      license: readLicense(this.o.home),
    };
  }

  private webBrain(): WebBrain {
    const b = this.brain;
    return {
      status: async () => b.status(),
      feed: async (q) => readFeed(this.sql, q),
      settings: this.o.settings,
      memory: async () => b.memoryView(),
      equity: async (days) => b.equityHistory(Date.now() - Math.min(35, Math.max(1, days)) * 86_400_000),
      forecast: async (s) => b.forecastView(s),
      consumeOnce: async (id) => b.consumeOnce(id),
      isRevoked: async (id) => b.isRevoked(id),
      pause: (a, by) => b.pause(a, by),
      resume: (a, by) => b.resume(a, by),
      setDial: (a, s, by, r) => b.setDial(a, s, by, r),
      unlock: (a, pm, by) => b.unlock(a, pm, by),
      flatten: async (a, by) => {
        const m = await b.flatten(a, `operator ${by}`);
        await b.flushJournal();
        return m;
      },
      court: (s, by) => b.requestCourt(s, by),
      why: (s) => b.why(s),
      roast: (s, t, by) => b.requestRoast(s, t, by),
      book: async () => {
        const r = await b.bookReview(true);
        return r
          ? `📒 Book review posted to the feed (REPORTS): ${r.lines.length} position(s), gross $${r.grossUsd}.`
          : "Book review unavailable.";
      },
      universe: () => b.universeView(),
    };
  }

  /** Node http → Fetch Request/Response bridge for the shared handlers. */
  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", this.url());
      const request = new Request(url, {
        method: req.method ?? "GET",
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v]],
        ) as [string, string][],
        ...(body.length && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      });
      const response = await this.route(request, url, req.socket.remoteAddress ?? "");
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`error: ${String(e).slice(0, 200)}`);
    }
  }

  async route(request: Request, url: URL, remote = "127.0.0.1"): Promise<Response> {
    const cfg = this.o.cfg;
    // ADR-076: a phone on the Wi-Fi can watch and use the controls, but settings and keys change only on this computer
    const local = isLoopback(remote);
    if (cfg.lan.enabled && !local && request.method === "POST" && url.pathname.startsWith("/api/settings/"))
      return Response.json(
        { ok: false, message: "Settings can only be changed on the computer CORTEX runs on." },
        { status: 403 },
      );
    if (request.method === "GET" && url.pathname === "/health") return Response.json(this.health());
    if (request.method === "GET" && url.pathname === "/pill") {
      if (!pillAuthorized(request.headers.get("authorization"), cfg.secrets.pill_token))
        return new Response("unauthorized", { status: 401 });
      const p = { ...pill(this.brain.status()), problem: this.problem() };
      return url.searchParams.get("format") === "swiftbar"
        ? new Response(swiftbar(p, `${this.url()}/`))
        : Response.json(p);
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/ingest/batch" || url.pathname === "/governor/export")
    ) {
      const body = await request.text();
      const ok = await verifySignedBody(
        cfg.secrets.ingest_hmac,
        request.headers.get("x-cortex-signature"),
        request.headers.get("x-cortex-timestamp"),
        body,
      );
      if (!ok) return new Response("bad signature", { status: 401 });
      if (url.pathname === "/ingest/batch") {
        const r = await this.brain.ingestBatch(JSON.parse(body));
        await this.brain.flushJournal();
        return Response.json(r, { status: r.ok ? 200 : 422 });
      }
      const q = JSON.parse(body) as { table?: string; after?: number; limit?: number };
      if (!EXPORT_TABLES.has(String(q.table))) return new Response("table not allowed", { status: 400 });
      await this.brain.flushJournal();
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
      const rows = (
        await this.d1
          .prepare(`SELECT rowid AS _rid, * FROM ${q.table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
          .bind(Number(q.after) || 0, limit)
          .all()
      ).results as { _rid: number }[];
      return Response.json({ rows, next: rows.at(-1)?._rid ?? null });
    }
    if (url.pathname.startsWith("/api/"))
      return handleWeb(
        request,
        {
          WEB_SESSION_SECRET: cfg.secrets.web_session,
          OPERATOR_DISCORD_ID: "local",
          DB: this.d1,
          SESSION_TTL_MS: 30 * 86_400_000, // your own computer: stay signed in (local mode is paper-only)
          COOKIE_INSECURE: cfg.lan.enabled, // plain HTTP on the user's Wi-Fi (ADR-076)
        },
        this.webBrain(),
      );
    if (request.method === "GET") return this.staticFile(url.pathname);
    return new Response("Not found", { status: 404 });
  }

  private staticFile(path: string): Response {
    const pub = resolve(this.o.root, "public");
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
    let file = resolve(pub, rel || "index.html");
    if (file !== pub && !file.startsWith(pub + sep)) return new Response("Not found", { status: 404 });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(pub, "index.html");
    if (!existsSync(file)) return new Response("web terminal not built (pnpm web:build)", { status: 503 });
    return new Response(readFileSync(file), {
      headers: {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
        ...SECURITY_HEADERS,
      },
    });
  }

  account(): AccountId {
    return "PAPER";
  }
}

export const isLoopback = (a: string) => /^(127\.|::1$|::ffff:127\.)/.test(a);

export interface ClefChoice {
  clef: ClefApi | null;
  clairic: ClairicApi | null;
  /** "cloudflare" (recommended) | "llm:<provider>/<model>" (stand-in, slightly weaker) | "off" */
  label: string;
}

/**
 * Clef + Clairic for local mode (ADR-063, operator 2026-10-26). Cloudflare Workers AI with the user's own account is
 * the real thing. Without it, the user's own LLM answers the same structured formats (ShimClef / ShimClairic): it
 * works, but a general chat model is less calibrated than Clef, so performance drops a little.
 */
export function resolveClef(cfg: LocalConfig, built: ReturnType<typeof buildPool>): ClefChoice {
  const k = cfg.keys;
  if (cfg.clef === "off") return { clef: null, clairic: null, label: "off" };
  if (cfg.clef !== "llm" && k.CLOUDFLARE_ACCOUNT_ID && k.CLOUDFLARE_API_TOKEN) {
    const cf = new CloudflareRestAi(k.CLOUDFLARE_ACCOUNT_ID, k.CLOUDFLARE_API_TOKEN);
    return { clef: new WorkersAiClef(cf), clairic: new WorkersAiClairic(cf), label: "cloudflare" };
  }
  if (cfg.clef === "cloudflare") return { clef: null, clairic: null, label: "off" };
  // the stand-in: a paid model if the user has one (usually the strongest), else the first in the pool
  const entries = built.report.entries;
  const pick = entries.find((e) => e.tier === "paid") ?? entries[0];
  const prov = pick ? built.providers[pick.provider] : undefined;
  if (pick && prov)
    return {
      clef: new ShimClef(prov, pick.model),
      clairic: new ShimClairic(prov, pick.model),
      label: `llm:${pick.source}/${pick.model}`,
    };
  return { clef: null, clairic: null, label: "off" };
}

/** What the user is told about Clef in setup, doctor and the settings page. */
export function clefNotice(label: string): { ok: boolean; level: "ok" | "degraded" | "off"; text: string } {
  if (label === "cloudflare")
    return { ok: true, level: "ok", text: "Clef + Clairic on your Cloudflare Workers AI (recommended)." };
  if (label.startsWith("llm:"))
    return {
      ok: true,
      level: "degraded",
      text: `Your own model (${label.slice(4)}) is standing in for Clef and Clairic. It works, but performance is marginally lower than with Cloudflare AI: a general model is less calibrated at sorting news and less exact at pulling numbers out of announcements. Add a free Cloudflare AI key to fix that.`,
    };
  return {
    ok: false,
    level: "off",
    text: "Clef is off: no Cloudflare AI key and no LLM. News triage, structure, the judge and catalyst facts are skipped; rule strategies still trade.",
  };
}
