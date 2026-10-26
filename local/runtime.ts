import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { AlpacaClient, AlpacaMarketData } from "../src/broker/AlpacaClient.ts";
import type { BrokerApi, MarketDataApi } from "../src/broker/types.ts";
import { type ClefApi, WorkersAiClef } from "../src/clef/ClefClient.ts";
import { type ClairicApi, WorkersAiClairic } from "../src/clef/clairic.ts";
import { CloudflareRestAi, ShimClef } from "../src/clef/portable.ts";
import { Brain, type PulseReport } from "../src/cortex/Brain.ts";
import { HOT_SCHEMA, HOT_SCHEMA_VERSION } from "../src/cortex/hot-schema.ts";
import { getKV, setKV } from "../src/cortex/store.ts";
import { LlmRouter } from "../src/court/llm.ts";
import { buildProviders, withByok } from "../src/court/providers.ts";
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
import { ntfyUrl, PushNotifier } from "../src/notify/push.ts";
import { handleWeb, loginLink, type WebBrain } from "../src/web/api.ts";
import { pill, pillAuthorized, swiftbar } from "../src/web/pill.ts";
import type { LocalConfig } from "./config.ts";
import { LocalJobs } from "./jobs.ts";
import { loadLocalScar, mergeScar } from "./memory.ts";
import { SimBroker } from "./simbroker.ts";
import { fileD1, fileSql, type LocalD1 } from "./store.ts";

/**
 * cortexd: the whole CORTEX-54 brain on one machine (ADR-064). Same Brain, same doctrine and constitution, same
 * journal schema; the Durable Object's alarm becomes a timer, D1 becomes a SQLite file, GitHub Actions become local
 * subprocesses, and the router becomes a small HTTP server bound to localhost. Two modes:
 *   demo  – a keyless simulated broker on live public crypto prices (nothing to sign up for);
 *   paper – the user's own Alpaca paper account (CORTEX needs it exclusively: don't share it with a cloud brain).
 * LIVE trading stays a cloud-and-ratification decision (constitution U8); local mode never holds live keys.
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
  overrides?: {
    broker?: BrokerApi;
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
    const noGuard = () => undefined;
    const rawMarket =
      o.overrides?.market ?? new AlpacaMarketData(alpacaKey ?? { keyId: "", secret: "" }, noGuard);
    const market = alpacaKey || o.overrides?.market ? rawMarket : keylessNews(rawMarket);
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

    const providers = buildProviders(k);
    const d = withByok(
      {
        ...DOCTRINE,
        // local mode has no free-tier walls: the doctrine's caps that only existed for them can relax
        universe: { ...DOCTRINE.universe, enabled: DOCTRINE.universe.enabled && Boolean(alpacaKey) },
      },
      providers,
      k,
    );
    const { clef, clairic } = this.clefFor(cfg, providers);
    this.console = new ConsoleNotifier(o.overrides?.quiet ?? false);
    const notifiers: Notifier[] = [this.console];
    if (k.DISCORD_BOT_TOKEN)
      notifiers.push(new DiscordNotifier(k.DISCORD_BOT_TOKEN, parseChannels(k.DISCORD_CHANNELS), noGuard));
    let notifier: Notifier = notifiers.length === 1 ? this.console : new Multi(notifiers);
    const push = ntfyUrl(k.NTFY_TOPIC, k.NTFY_URL);
    if (push) notifier = new PushNotifier(notifier, push, noGuard);

    this.jobs = new LocalJobs({ researchDir: join(root, "research"), home, url: this.url(), cfg });
    this.brain = new Brain({
      sql: this.sql,
      d,
      c: CONSTITUTION,
      brokers: { PAPER: broker },
      market,
      notifier,
      d1: this.d1,
      readKillFlag: async () => existsSync(join(home, "KILLED")),
      now,
      clef: o.overrides?.clef !== undefined ? o.overrides.clef : clef,
      clairic,
      llm: Object.keys(providers).length ? new LlmRouter(providers, d) : null,
      calibration: CALIBRATION,
      scar: mergeScar(SCAR_TISSUE, loadLocalScar(home)), // + memory packs the operator applied (ADR-068)
      dispatcher: cfg.research.enabled ? this.jobs : null,
      http: o.overrides?.http ?? (o.overrides?.market ? null : (u, i) => fetch(u, i)),
      hub: hubFromEnv(k),
    });
    this.brain.init({
      constitution_sha256: CONSTITUTION_SHA256,
      doctrine_sha256: DOCTRINE_SHA256,
      hot_schema_version: HOT_SCHEMA_VERSION,
      accounts: ["PAPER"],
      host: "local",
      mode: cfg.mode,
    });
  }

  url(): string {
    return `http://${this.o.cfg.bind === "0.0.0.0" ? "127.0.0.1" : this.o.cfg.bind}:${this.o.cfg.port}`;
  }

  private clefFor(
    cfg: LocalConfig,
    providers: ReturnType<typeof buildProviders>,
  ): { clef: ClefApi | null; clairic: ClairicApi | null } {
    const k = cfg.keys;
    const cf =
      k.CLOUDFLARE_ACCOUNT_ID && k.CLOUDFLARE_API_TOKEN
        ? new CloudflareRestAi(k.CLOUDFLARE_ACCOUNT_ID, k.CLOUDFLARE_API_TOKEN)
        : null;
    if (cfg.clef === "off") return { clef: null, clairic: null };
    if (cf && cfg.clef !== "shim") return { clef: new WorkersAiClef(cf), clairic: new WorkersAiClairic(cf) };
    if (cfg.clef === "cloudflare") return { clef: null, clairic: null };
    // shim: the strongest model the user has a key for
    const order: [string, string | undefined][] = [
      ["anthropic", "claude-opus-5-5"],
      ["openai", k.OPENAI_MODEL || "gpt-5"],
      ["custom", k.CUSTOM_LLM_MODEL],
      ["ollama", k.OLLAMA_MODEL],
      ["gemini", "gemini-3.5-flash"],
      ["groq", "openai/gpt-oss-120b"],
    ];
    for (const [p, model] of order) {
      const prov = providers[p];
      if (prov && model) return { clef: new ShimClef(prov, model), clairic: null };
    }
    return { clef: null, clairic: null };
  }

  /** One pulse (also what the timer runs). */
  async pulse(): Promise<PulseReport> {
    const r = await this.brain.pulse();
    this.lastReport = r;
    return r;
  }

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
      this.server.listen(this.o.cfg.port, this.o.cfg.bind, () => res());
    });
    this.schedule(1);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    await this.brain.flushJournal().catch(() => undefined);
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
    };
  }

  private webBrain(): WebBrain {
    const b = this.brain;
    return {
      status: async () => b.status(),
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
          ? `📒 Book review: ${r.lines.length} position(s), gross $${r.grossUsd}`
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
      const response = await this.route(request, url);
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

  async route(request: Request, url: URL): Promise<Response> {
    const cfg = this.o.cfg;
    if (request.method === "GET" && url.pathname === "/health") return Response.json(this.health());
    if (request.method === "GET" && url.pathname === "/pill") {
      if (!pillAuthorized(request.headers.get("authorization"), cfg.secrets.pill_token))
        return new Response("unauthorized", { status: 401 });
      const p = pill(this.brain.status());
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
        { WEB_SESSION_SECRET: cfg.secrets.web_session, OPERATOR_DISCORD_ID: "local", DB: this.d1 },
        this.webBrain(),
      );
    if (request.method === "GET") return this.staticFile(url.pathname);
    return new Response("Not found", { status: 404 });
  }

  private staticFile(path: string): Response {
    const pub = resolve(this.o.root, "public");
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
    let file = resolve(pub, rel || "index.html");
    if (!file.startsWith(pub)) return new Response("Not found", { status: 404 });
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
