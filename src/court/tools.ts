/**
 * Court tools (open court, ADR-096). What a debating seat may do between statements to check a fact: arithmetic, web
 * and news search, reading a page, an encyclopedia summary, and looking up a field of the evidence it was given.
 *
 * Tools only READ. None can place, size or change anything; the risk engine and the contract checks are unchanged.
 * Everything a tool returns is third-party data and reaches the model inside an <untrusted> fence (prompts.ts).
 * Every network tool goes through `publicUrl` (no private, loopback, link-local or metadata addresses), has a timeout,
 * and its text is capped, so one call can't hang a hearing or flood a model's context.
 */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ToolCall {
  tool: string;
  input: string;
}
export interface ToolResult {
  tool: string;
  input: string;
  ok: boolean;
  output: string;
  ms: number;
}

export const TOOL_SPECS: readonly { name: string; input: string; use: string }[] = [
  {
    name: "calc",
    input: "an arithmetic expression",
    use: "exact arithmetic: + - * / ^ %, sqrt ln log exp abs min max round",
  },
  {
    name: "evidence",
    input: "a dotted path, e.g. technicals.atr14",
    use: "read one field of the evidence JSON",
  },
  { name: "web_search", input: "a search query", use: "web results (title, link, snippet)" },
  { name: "news_search", input: "a search query", use: "recent news headlines with dates" },
  {
    name: "read_url",
    input: "an https URL from a search result",
    use: "the readable text of one page (first ~4,000 characters)",
  },
  { name: "wikipedia", input: "a topic", use: "a short encyclopedia summary" },
];
export const TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.name));

const MAX_OUT = 4_000;
const TIMEOUT_MS = 15_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Savant/1.0";

// ------------------------------------------------------------------ calc (no eval: a small recursive-descent parser)

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  pow: Math.pow,
};

/** Evaluate an arithmetic expression. Throws on anything that isn't arithmetic. Pure. */
export function calc(expr: string): number {
  // thousands separators ("1,250.5") only when there are no function calls, whose arguments use commas
  const raw = expr.replace(/\s+/g, "");
  const src = /[a-z]/i.test(raw) ? raw : raw.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  if (src.length === 0 || src.length > 500) throw new Error("expression is empty or too long");
  let i = 0;
  const peek = () => src[i] ?? "";
  const eat = (c: string) => {
    if (src[i] !== c) throw new Error(`expected "${c}" at ${i}`);
    i++;
  };
  const number = (): number => {
    const m = /^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) throw new Error(`unexpected "${peek() || "end"}" at ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const primary = (): number => {
    if (peek() === "(") {
      eat("(");
      const v = sum();
      eat(")");
      return v;
    }
    const f = /^[a-z]+/i.exec(src.slice(i));
    if (f) {
      const name = f[0].toLowerCase();
      if (name === "pi" || name === "e") {
        i += name.length;
        return name === "pi" ? Math.PI : Math.E;
      }
      const fn = FUNCS[name];
      if (!fn) throw new Error(`unknown function ${name}`);
      i += f[0].length;
      eat("(");
      const args = [sum()];
      while (peek() === ",") {
        eat(",");
        args.push(sum());
      }
      eat(")");
      return fn(...args);
    }
    return number();
  };
  const unary = (): number => {
    if (peek() === "-") {
      i++;
      return -unary();
    }
    if (peek() === "+") {
      i++;
      return unary();
    }
    let v = primary();
    if (peek() === "%") {
      i++;
      v /= 100;
    }
    return v;
  };
  const power = (): number => {
    const b = unary();
    if (peek() === "^") {
      i++;
      return b ** power();
    }
    return b;
  };
  const product = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/") {
      const op = src[i++];
      const r = power();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = src[i++];
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  if (i !== src.length) throw new Error(`unexpected "${peek()}" at ${i}`);
  if (!Number.isFinite(v)) throw new Error("result is not a finite number");
  return v;
}

// ------------------------------------------------------------------ network safety

/** Only public http(s) hosts: never loopback, private ranges, link-local, metadata services or credentials. Pure. */
export function publicUrl(u: string): URL | null {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal"))
    return null;
  if (h === "metadata" || h === "metadata.google.internal") return null;
  if (/^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return null;
  if (h.includes(":") && (/^(::1?|fe80:|fc|fd)/i.test(h) || h.startsWith("::ffff:"))) return null;
  if (/^\d+$/.test(h)) return null; // decimal-encoded addresses
  return url;
}

/** Plain text of an HTML page: scripts, styles and tags out, entities decoded, whitespace folded. Pure. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return {
    title: decode(title).trim(),
    text: decode(body)
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim(),
  };
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

async function get(f: Fetcher, url: string, init: RequestInit = {}): Promise<Response> {
  return f(url, {
    ...init,
    redirect: "follow",
    headers: {
      "user-agent": UA,
      accept: "text/html,application/json,application/xml;q=0.9,*/*;q=0.5",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function text(r: Response, cap = 600_000): Promise<string> {
  const t = await r.text();
  return t.length > cap ? t.slice(0, cap) : t;
}

// ------------------------------------------------------------------ the tools

async function webSearch(f: Fetcher, q: string): Promise<string> {
  const r = await get(f, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`search answered HTTP ${r.status}`);
  const html = await text(r);
  const out: string[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  for (const m of html.matchAll(re)) {
    let href = decode(m[1] ?? "");
    const u = /[?&]uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1] as string);
    if (!href.startsWith("http") || href.includes("duckduckgo.com/y.js")) continue;
    out.push(`- ${htmlToText(m[2] ?? "").text} — ${href}\n  ${htmlToText(m[3] ?? "").text.slice(0, 240)}`);
    if (out.length >= 8) break;
  }
  return out.length ? out.join("\n") : "no results";
}

async function newsSearch(f: Fetcher, q: string): Promise<string> {
  const r = await get(
    f,
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`,
  );
  if (!r.ok) throw new Error(`news search answered HTTP ${r.status}`);
  const xml = await text(r);
  const out: string[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1] ?? "";
    const pick = (tag: string) =>
      decode(
        (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(it)?.[1] ?? "").replace(
          /<!\[CDATA\[|\]\]>/g,
          "",
        ),
      );
    const date = Date.parse(pick("pubDate"));
    out.push(
      `- ${Number.isFinite(date) ? new Date(date).toISOString().slice(0, 16).replace("T", " ") : "undated"} · ${pick("title")} — ${pick("link")}`,
    );
    if (out.length >= 10) break;
  }
  return out.length ? out.join("\n") : "no news found";
}

async function readUrl(f: Fetcher, raw: string): Promise<string> {
  const url = publicUrl(raw.trim());
  if (!url) throw new Error("only public http(s) addresses can be read");
  const r = await get(f, url.toString());
  if (!r.ok) throw new Error(`the page answered HTTP ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  if (!/text|html|json|xml/i.test(type)) throw new Error(`not a text page (${type || "unknown type"})`);
  const page = await text(r);
  const { title, text: body } = /html/i.test(type) ? htmlToText(page) : { title: "", text: page };
  return `${title ? `${title}\n` : ""}${body}`;
}

async function wikipedia(f: Fetcher, topic: string): Promise<string> {
  const r = await get(
    f,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.trim().replace(/ /g, "_"))}`,
    {
      headers: { accept: "application/json" },
    },
  );
  if (!r.ok)
    throw new Error(r.status === 404 ? "no article by that name" : `Wikipedia answered HTTP ${r.status}`);
  const j = (await r.json()) as { title?: string; extract?: string };
  return `${j.title ?? topic}: ${j.extract ?? "(no summary)"}`;
}

function evidenceField(evidence: unknown, path: string): string {
  let cur: unknown = evidence;
  for (const k of path.split(".").filter(Boolean)) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>))
      cur = (cur as Record<string, unknown>)[k];
    else throw new Error(`no field ${path}`);
  }
  return JSON.stringify(cur);
}

export interface ToolBox {
  run(call: ToolCall): Promise<ToolResult>;
  /** how many calls ran (the hearing logs it) */
  readonly calls: number;
}

/**
 * The tools a hearing's seats share. `fetcher` null = no network (cloud brain, tests, demo without internet): the
 * network tools then answer "not available" and the seats argue from the evidence only.
 */
export function toolBox(
  evidence: unknown,
  fetcher: Fetcher | null,
  now: () => number = () => Date.now(),
): ToolBox {
  let calls = 0;
  const cache = new Map<string, string>();
  return {
    get calls() {
      return calls;
    },
    async run(call: ToolCall): Promise<ToolResult> {
      const t0 = now();
      const input = String(call.input ?? "").slice(0, 500);
      const done = (ok: boolean, output: string): ToolResult => ({
        tool: call.tool,
        input,
        ok,
        output: output.length > MAX_OUT ? `${output.slice(0, MAX_OUT)}…[cut]` : output,
        ms: now() - t0,
      });
      calls++;
      if (!TOOL_NAMES.has(call.tool)) return done(false, `unknown tool "${call.tool}"`);
      const key = `${call.tool}:${input}`;
      const hit = cache.get(key);
      if (hit !== undefined) return done(true, hit);
      try {
        let out: string;
        if (call.tool === "calc") out = String(Number(calc(input).toPrecision(12)));
        else if (call.tool === "evidence") out = evidenceField(evidence, input);
        else if (!fetcher)
          return done(false, "web tools are not available in this hearing; argue from the evidence");
        else if (call.tool === "web_search") out = await webSearch(fetcher, input);
        else if (call.tool === "news_search") out = await newsSearch(fetcher, input);
        else if (call.tool === "read_url") out = await readUrl(fetcher, input);
        else out = await wikipedia(fetcher, input);
        cache.set(key, out);
        return done(true, out);
      } catch (e) {
        return done(false, String(e instanceof Error ? e.message : e).slice(0, 300));
      }
    },
  };
}
