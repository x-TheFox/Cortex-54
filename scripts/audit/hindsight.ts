/**
 * Pre-release audit: does a court model "predict" from memory? (docs/audit/HARNESS.md §hindsight)
 *
 *   GROQ_API_KEY=… pnpm exec tsx scripts/audit/hindsight.ts
 *
 * Sends the shipped bull and bear system prompts (src/court/prompts.ts) with an evidence pack built ONLY from data up to
 * time T (hourly bars from the replay cache + the episode's headlines up to T), then searches the answers for facts
 * that were not in the evidence: the episode's outcome terms and any date after T. Each case runs twice: with the real
 * date and symbol, and masked (date shifted, symbol renamed), to separate memory from reasoning.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BEAR_SCHEMA, BEAR_SYSTEM, BULL_SCHEMA, BULL_SYSTEM, untrusted } from "../../src/court/prompts.ts";
import type { Bar } from "../../src/strategy/indicators.ts";
import { EPISODES } from "./episodes.ts";

const KEY = process.env.GROQ_API_KEY ?? "";
const MODEL = process.env.HINDSIGHT_MODEL ?? "openai/gpt-oss-120b";

const CASES = [
  { ep: "ftx", symbol: "SOL/USD", at: "2022-11-07T12:00:00Z" },
  { ep: "luna", symbol: "BTC/USD", at: "2022-05-09T12:00:00Z" },
  { ep: "carry", symbol: "BTC/USD", at: "2024-08-04T12:00:00Z" },
];

function atr14(d: Bar[]): number {
  const tr = d
    .slice(-15)
    .map((b, i, a) =>
      i === 0
        ? b.h - b.l
        : Math.max(b.h - b.l, Math.abs(b.h - (a[i - 1] as Bar).c), Math.abs(b.l - (a[i - 1] as Bar).c)),
    );
  return tr.slice(1).reduce((s, x) => s + x, 0) / 14;
}

async function ask(system: string, user: string, schema: object, tries = 4): Promise<string> {
  await new Promise((r) => setTimeout(r, 25_000)); // free tier: 8K tokens/min
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      max_tokens: 1500,
      messages: [
        { role: "system", content: `${system}\nJSON schema: ${JSON.stringify(schema)}` },
        { role: "user", content: user },
      ],
    }),
  });
  const d = (await r.json()) as { choices?: { message: { content: string } }[]; error?: { message: string } };
  if (r.status === 429 && tries > 0) return ask(system, user, schema, tries - 1);
  return (
    d.choices?.[0]?.message.content ??
    `ERROR ${r.status} ${(d.error?.message ?? "").replace(/org_[a-z0-9]+/g, "org_…")}`
  );
}

const out: unknown[] = [];
for (const c of CASES) {
  const ep = EPISODES.find((e) => e.id === c.ep);
  if (!ep || !existsSync(`docs/audit/runs/episodes/${c.ep}.json`)) continue;
  const T = Date.parse(c.at);
  const hourly =
    (JSON.parse(readFileSync(`docs/audit/runs/episodes/${c.ep}.json`, "utf8")) as Record<string, Bar[]>)[
      c.symbol
    ] ?? [];
  const upto = hourly.filter((b) => b.t + 3_600_000 <= T);
  const days = new Map<number, Bar>();
  for (const b of upto) {
    const d = Math.floor(b.t / 86_400_000) * 86_400_000;
    const x = days.get(d);
    if (!x) days.set(d, { ...b, t: d });
    else Object.assign(x, { h: Math.max(x.h, b.h), l: Math.min(x.l, b.l), c: b.c });
  }
  const daily = [...days.values()].slice(-20);
  const last = upto.at(-1) as Bar;
  const headlines = ep.news
    .filter((n) => Date.parse(n.at) <= T)
    .map((n, i) => ({ id: `news_${i}`, at: n.at, headline: n.headline }));
  for (const masked of [false, true]) {
    const shift = masked ? 1_000 * 86_400_000 : 0; // ~2.7 years later
    const sym = masked ? "ASSET-X/USD" : c.symbol;
    const scrub = (s: string) =>
      masked
        ? s.replace(
            /Binance|FTX|Alameda|FTT|LUNA|UST|Terra|Luna Foundation Guard|Tether|Nikkei|yen|Bank of Japan|SOL|Bitcoin|bitcoin/g,
            "[entity]",
          )
        : s;
    const evidence = {
      now: new Date(T + shift).toISOString(),
      symbol: sym,
      quote: { bid: last.c * 0.9996, ask: last.c * 1.0004 },
      technicals: {
        atr14: atr14(daily),
        close: last.c,
        high20: Math.max(...daily.map((b) => b.h)),
        low20: Math.min(...daily.map((b) => b.l)),
      },
      daily: daily.map((b) => ({
        d: new Date(b.t + shift).toISOString().slice(0, 10),
        o: +b.o.toFixed(3),
        h: +b.h.toFixed(3),
        l: +b.l.toFixed(3),
        c: +b.c.toFixed(3),
      })),
    };
    const user = `evidence = ${JSON.stringify(evidence)}\n${untrusted("news", JSON.stringify(headlines.map((h) => ({ ...h, at: new Date(Date.parse(h.at) + shift).toISOString(), headline: scrub(h.headline) }))))}`;
    const bull = await ask(BULL_SYSTEM, user, BULL_SCHEMA);
    const bear = await ask(BEAR_SYSTEM, `${user}\nbull_brief = ${untrusted("bull", bull)}`, BEAR_SCHEMA);
    const text = `${bull}\n${bear}`;
    const yearAfter = new Date(T).getUTCFullYear();
    const futureDates = [...text.matchAll(/20\d\d-\d\d-\d\d/g)]
      .map((m) => m[0])
      .filter((d) => Date.parse(d) > T + shift + 86_400_000);
    const terms = ep.outcome_terms.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
    const memoryWords = [
      "bankrupt",
      "chapter 11",
      "collapse of ftx",
      "arrest",
      "went to zero",
      "death spiral",
      "wiped out",
      "recovered",
      "rebound",
    ].filter((w) => text.toLowerCase().includes(w));
    out.push({
      case: c,
      masked,
      model: MODEL,
      bull,
      bear,
      flags: { outcome_terms: terms, memory_words: memoryWords, dates_after_T: futureDates, year: yearAfter },
    });
    console.log(
      `${c.ep} ${c.symbol} masked=${masked}: outcome terms ${JSON.stringify(terms)} memory words ${JSON.stringify(memoryWords)} future dates ${futureDates.length}`,
    );
  }
}
writeFileSync("docs/audit/runs/hindsight.json", JSON.stringify(out, null, 2));
