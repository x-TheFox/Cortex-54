// Court smoke test against REAL providers (never trades): live Alpaca evidence → bull → cross-family bear →
// Clef 27B synth (Workers AI REST) → contract checks. Prints which hops answered and whether the contract is valid.
//
//   set -a; . ./.dev.vars; set +a; CF_API_TOKEN=$(pnpm -s wrangler auth token) CF_ACCOUNT_ID=… \
//     node scripts/court-smoke.ts [SYMBOL] ["catalyst headline"]
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { AlpacaMarketData } from "../src/broker/AlpacaClient.ts";
import type { ClefApi, ClefQuestion } from "../src/clef/ClefClient.ts";
import { ClefResultSchema } from "../src/clef/ClefClient.ts";
import { contractViolations, DecisionContractSchema } from "../src/contracts/decision-contract.ts";
import { DoctrineSchema } from "../src/contracts/doctrine.ts";
import { type CourtSession, courtSessionCard } from "../src/cortex/Brain.ts";
import {
  BearSchema,
  BullSchema,
  buildCourtContract,
  buildSynth,
  calibrate,
  checkBull,
  interpretSynth,
  PanelOpinionSchema,
  RebuttalSchema,
  type SeatOpinion,
} from "../src/court/court.ts";
import { buildEvidence, evidenceForModels } from "../src/court/evidence.ts";
import {
  GeminiProvider,
  type HopAttempt,
  type LlmProvider,
  LlmRouter,
  OpenAICompatProvider,
} from "../src/court/llm.ts";
import {
  BEAR_SCHEMA,
  BEAR_SYSTEM,
  BULL_SCHEMA,
  BULL_SYSTEM,
  PANEL_SCHEMA,
  PANEL_SEATS,
  panelSystem,
  REBUTTAL_SCHEMA,
  REBUTTAL_SYSTEM,
} from "../src/court/prompts.ts";

const env = process.env;
const d = DoctrineSchema.parse(parse(readFileSync("config/doctrine.yaml", "utf8")));
const symbol = process.argv[2] ?? "BTC/USD";
const headline = process.argv[3] ?? "Smoke test: no real catalyst — judge on technicals and regime only";
const now = Date.now();

const creds = { keyId: env.ALPACA_PAPER_KEY_ID ?? "", secret: env.ALPACA_PAPER_SECRET ?? "" };
const md = new AlpacaMarketData(creds, () => {});
const crypto = symbol.includes("/");
const [bars, quotes] = await Promise.all([
  crypto ? md.cryptoDailyBars([symbol], 70, now) : md.stockDailyBars([symbol], 70, now),
  crypto ? md.cryptoQuotes([symbol]) : md.stockQuotes([symbol]),
]);
const q = quotes[symbol];
const b = bars[symbol];
if (!q || !b) throw new Error(`no data for ${symbol}`);
const e = buildEvidence({
  symbol,
  arena: crypto ? "CRYPTO" : "EQUITIES",
  bars: b,
  bid: q.bid,
  ask: q.ask,
  now,
  regime: { crypto: { posture: "NEW_ENTRY_ALLOWED", score: 65 } },
  world: null,
  catalyst: {
    candidateId: "smoke",
    kind: "news",
    headline,
    source: "smoke",
    url: null,
    ageMinutes: 0,
    tier1: null,
  },
  held: [],
});
if (!e) throw new Error("not enough bars");
console.log(
  `evidence ${symbol}: bid ${e.quote.bid} atr ${e.technicals.atr14} ema20 ${e.technicals.ema20} rsi ${e.technicals.rsi14}`,
);

const providers: Partial<Record<string, LlmProvider>> = {};
if (env.GEMINI_API_KEY) providers.gemini = new GeminiProvider(env.GEMINI_API_KEY);
if (env.GROQ_API_KEY)
  providers.groq = new OpenAICompatProvider("groq", "https://api.groq.com/openai/v1", env.GROQ_API_KEY, {
    jsonMode: true,
    reasoningEffort: "low",
  });
if (env.NVIDIA_API_KEY)
  providers.nim = new OpenAICompatProvider("nim", "https://integrate.api.nvidia.com/v1", env.NVIDIA_API_KEY, {
    jsonMode: false,
  });
const router = new LlmRouter(providers, d);
const log = (role: string) => (a: HopAttempt) =>
  console.log(
    `  ${role} ${a.provider}/${a.model} [${a.family}] ${a.outcome} ${a.latencyMs}ms${a.error ? ` — ${a.error.slice(0, 120)}` : ""}`,
  );

const evJson = JSON.stringify(evidenceForModels(e));
const bull = await router.run(
  d.llm_routing.bull_chain,
  {
    system: BULL_SYSTEM,
    user: `Evidence JSON (ids: ${e.receipts.map((r) => r.evidence_id).join(", ")}):\n${evJson}`,
    maxOutputTokens: 1500,
    schema: BULL_SCHEMA as unknown as Record<string, unknown>,
  },
  (j) => BullSchema.parse(j),
  [],
  log("BULL"),
);
if (!bull) throw new Error("no bull");
console.log("bull:", JSON.stringify(bull.value));
const checked = checkBull(bull.value, e, d);
console.log("bull check:", checked.ok ? `OK ${checked.notes.join("; ")}` : checked.reasons.join("; "));
if (!checked.ok) process.exit(0);

const bear = await router.run(
  d.llm_routing.bear_chain,
  {
    system: BEAR_SYSTEM,
    user: `Evidence JSON:\n${evJson}\n\nBull brief JSON:\n${JSON.stringify(checked.bull)}`,
    maxOutputTokens: 1500,
    schema: BEAR_SCHEMA as unknown as Record<string, unknown>,
  },
  (j) => BearSchema.parse(j),
  [bull.family],
  log("BEAR"),
);
if (!bear) throw new Error("no cross-family bear");
console.log(
  "bear lethality:",
  bear.value.lethality,
  "| flaws:",
  bear.value.fatal_flaws.join(" / ").slice(0, 200),
);

// ADR-044: rebuttal, then the expert panel in parallel
const reb = await router.run(
  [{ provider: bull.provider, model: bull.model }, ...d.llm_routing.bull_chain],
  {
    system: REBUTTAL_SYSTEM,
    user: `Evidence JSON:\n${evJson}\n\nYour brief JSON:\n${JSON.stringify(checked.bull)}\n\nBear attack JSON:\n${JSON.stringify(bear.value)}`,
    maxOutputTokens: 1200,
    schema: REBUTTAL_SCHEMA as unknown as Record<string, unknown>,
  },
  (j) => RebuttalSchema.parse(j),
  [bear.family],
  log("REBUTTAL"),
);
const rebuttal = reb
  ? { ...reb.value, revised_conviction: Math.min(reb.value.revised_conviction, checked.bull.conviction) }
  : null;
console.log(
  "rebuttal:",
  rebuttal ? `${rebuttal.still_long ? "holds" : "WITHDRAWS"} conv ${rebuttal.revised_conviction}` : "none",
);
const pc = d.llm_routing.panel;
const panel = (
  await Promise.all(
    pc.seats.map(async (id, i) => {
      const seat = PANEL_SEATS.find((s) => s.id === id);
      if (!seat) return null;
      const chain = [...pc.chain.slice(i), ...pc.chain.slice(0, i)];
      const req = {
        system: panelSystem(seat),
        user: `Evidence JSON:\n${evJson}\n\nBull brief:\n${JSON.stringify(checked.bull)}\n\nBear attack:\n${JSON.stringify(bear.value)}${rebuttal ? `\n\nBull rebuttal:\n${JSON.stringify(rebuttal)}` : ""}`,
        maxOutputTokens: 800,
        schema: PANEL_SCHEMA as unknown as Record<string, unknown>,
      };
      const parse = (j: unknown) => PanelOpinionSchema.parse(j);
      const r = await router.run(chain, req, parse, [], log(id.toUpperCase()), pc.timeout_ms);
      return r
        ? ({
            ...r.value,
            seat: id,
            title: seat.title,
            emoji: seat.emoji,
            by: `${r.provider}/${r.model}`,
          } as SeatOpinion)
        : null;
    }),
  )
).filter((x): x is SeatOpinion => x !== null);
for (const p of panel) console.log(`panel ${p.title}: ${p.stance} ${p.confidence} — ${p.headline}`);

const clef: ClefApi = {
  async run(model, state, questions: Record<string, ClefQuestion>) {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
      },
    );
    const j = (await r.json()) as { result?: unknown; errors?: unknown };
    if (!r.ok) throw new Error(JSON.stringify(j.errors));
    return ClefResultSchema.parse(j.result);
  },
};
const sReq = buildSynth(e, checked.bull, bear.value, { rebuttal, panel });
const sRes = await clef.run("clef", sReq.state, sReq.questions);
const synth = interpretSynth(sRes);
console.log("synth:", JSON.stringify(synth), "tokens", sRes.usage.input_tokens);
if (!synth) process.exit(0);
const k = buildCourtContract({
  contractId: "01928f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f",
  now,
  evidence: e,
  bull: checked.bull,
  bear: bear.value,
  synth,
  calibratedWin: calibrate(synth.winProb, 0, d),
  tick: crypto ? 0.01 : 0.01,
  models: {
    bull: { provider: bull.provider, model: bull.model, family: bull.family },
    bear: { provider: bear.provider, model: bear.model, family: bear.family },
  },
  d,
});
const parsed = DecisionContractSchema.safeParse(k);
console.log(
  "contract:",
  parsed.success
    ? `valid · violations ${JSON.stringify(contractViolations(parsed.data))}`
    : parsed.error.issues,
);

// --post: show the card in #bull-vs-bear-court (labelled as a smoke test; nothing is traded).
if (process.argv.includes("--post") && env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_COURT) {
  const session: CourtSession = {
    symbol,
    arena: e.arena,
    catalyst: e.catalyst,
    bid: e.quote.bid,
    atr: e.technicals.atr14,
    bull: { ...checked.bull, by: `${bull.provider}/${bull.model}` },
    bear: { ...bear.value, by: `${bear.provider}/${bear.model}` },
    ...(rebuttal && reb ? { rebuttal: { ...rebuttal, by: `${reb.provider}/${reb.model}` } } : {}),
    panel,
    facts: e.facts?.values ?? null,
    kronos: e.forecast?.view ?? null,
    synth: { ...synth, calibrated: calibrate(synth.winProb, 0, d) },
    verdict: `🧪 Smoke test from the dev machine — not routed to any account. Contract ${parsed.success ? "valid" : "INVALID"}.`,
    ok: false,
  };
  const r = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_COURT}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ...courtSessionCard(session), allowed_mentions: { parse: [] } }),
  });
  console.log("posted to #bull-vs-bear-court:", r.status);
}
