/**
 * What the brain says, as cards and lines (split out of Brain.ts, ADR-078 / PSS-006): the HUD, contract, posture,
 * intel, dossier, book, review and courtroom cards, the agent-terminal lines and the equity chart. Pure functions of
 * their inputs; the brain decides when to post them.
 */
import type { TriageItem } from "../clef/triage.ts";
import type { Batch, Dossier } from "../contracts/batch.ts";
import type { DecisionContract } from "../contracts/decision-contract.ts";
import type { Rebuttal, SeatOpinion } from "../court/court.ts";
import { COLORS, type DiscordMessage } from "../discord/notifier.ts";
import type { BookSummary } from "../portfolio/book.ts";
import { stagnant } from "../portfolio/exits.ts";
import type { Band } from "../risk/CircuitBreakerLadder.ts";
import type { Facts } from "../risk/scar.ts";
import { atr } from "../strategy/indicators.ts";
import type { StatusView } from "./Brain.ts";
import { one } from "./store.ts";

const TERMINAL_KINDS: Record<string, string> = {
  ENTRY_FACTS: "🎯",
  ORDER_SUBMITTED: "📨",
  FILL: "💱",
  EXIT: "🏁",
  RED_LOCK: "🛑",
  UNLOCK: "🔓",
  MODE: "⚙️",
  DIAL: "🎚️",
  FLATTEN: "🧹",
  KILL_SEEN: "☠️",
  KILL_CLEARED: "✅",
  COURT: "⚖️",
  DISPATCH: "📤",
  GOVERNOR: "🧬",
  OPTIONS_LAB: "🧪",
  INGEST_REJECTED: "⚠️",
  DAY_ROLL: "🔗",
};

/** One compact line per notable journal event for #agent-terminal; null for the rest. */
export function terminalLine(r: {
  ts: number;
  account: string;
  kind: string;
  refId: string | null;
  payloadJson: string;
}): string | null {
  const icon = TERMINAL_KINDS[r.kind];
  if (!icon) return null;
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(r.payloadJson) as Record<string, unknown>;
  } catch {
    p = {};
  }
  const f = (p.facts ?? {}) as Record<string, unknown>;
  const detail =
    r.kind === "ENTRY_FACTS"
      ? `${f.symbol ?? ""} ${f.strategy_id ?? ""} w=${p.reputation_weight ?? 1}`
      : r.kind === "DISPATCH"
        ? String(p.job ?? "")
        : r.kind === "EXIT"
          ? `${p.symbol ?? ""} ${p.reason ?? ""} ${typeof p.pnl_cents === "number" ? `$${(p.pnl_cents / 100).toFixed(2)}` : ""}`
          : r.kind === "FILL"
            ? `${p.role ?? ""} ${p.qty ?? ""} @ ${p.price ?? ""}`
            : JSON.stringify(p).slice(0, 120);
  const hhmm = new Date(r.ts).toISOString().slice(11, 16);
  const acct = r.account === "SYSTEM" ? "" : ` ${r.account}`;
  return `\`${hhmm}\` ${icon} ${r.kind}${acct} ${detail}`.slice(0, 200);
}

/** QuickChart line image for the HUD (rendered off-platform: zero Worker CPU). */
/** Benchmark lines: each series scaled so it starts at the account's first equity sample. Pure. */
export function benchmarkLines(
  equity: number[][],
  rows: { at: number; btc: number | null; spy: number | null }[],
): { btc: number[][]; spy: number[][] } {
  const start = equity[0];
  if (!start) return { btc: [], spy: [] };
  const line = (k: "btc" | "spy") => {
    const valid = rows.filter(
      (r) => r.at >= (start[0] as number) && typeof r[k] === "number" && (r[k] as number) > 0,
    );
    const base = valid[0]?.[k];
    return base
      ? valid.map((r) => [r.at, Math.round((((start[1] as number) * (r[k] as number)) / base) * 100) / 100])
      : [];
  };
  return { btc: line("btc"), spy: line("spy") };
}

export function equityChartUrl(
  points: number[][] | undefined,
  bench?: { btc: number[][]; spy: number[][] },
): string | null {
  if (!points || points.length < 2) return null;
  const pts = points.slice(-72);
  const align = (series: number[][] | undefined) => {
    if (!series?.length) return null;
    const at = new Map(series.map((p) => [p[0], p[1]]));
    return pts.map((p) => at.get(p[0]) ?? null);
  };
  const extra = [
    ["BTC hold", "#f5a524", align(bench?.btc)],
    ["SPY hold", "#3ddc84", align(bench?.spy)],
  ] as const;
  const cfg = {
    type: "line",
    data: {
      labels: pts.map(() => ""),
      datasets: [
        {
          label: "Savant",
          data: pts.map((p) => p[1]),
          fill: false,
          pointRadius: 0,
          borderColor: "#38bdf8",
          borderWidth: 2,
        },
        ...extra
          .filter(([, , d]) => d?.some((x) => x !== null))
          .map(([label, color, d]) => ({
            label,
            data: d,
            fill: false,
            pointRadius: 0,
            borderColor: color,
            borderWidth: 1,
            borderDash: [4, 3],
            spanGaps: true,
          })),
      ],
    },
    options: {
      legend: { display: true, labels: { fontColor: "#9ca3af", boxWidth: 10 } },
      scales: { xAxes: [{ display: false }] },
    },
  };
  return `https://quickchart.io/chart?w=500&h=140&bkg=%23111827&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Add business days (Mon–Fri). Holidays aren't modeled, which is why callers add a day of buffer. */
export function addBusinessDays(ts: number, days: number): number {
  let t = ts;
  let left = days;
  while (left > 0) {
    t += 86_400_000;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return t;
}

const bandColor = (b: Band) =>
  b === "GREEN" ? COLORS.green : b === "YELLOW" ? COLORS.yellow : b === "ORANGE" ? COLORS.orange : COLORS.red;
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

export function hudMessage(s: StatusView): DiscordMessage {
  const age = s.lastPulseAt === null ? "never" : `${Math.round((s.now - s.lastPulseAt) / 1000)}s ago`;
  const embeds = s.accounts.map((a) => ({
    ...(equityChartUrl(s.equity[a.account], s.benchmark?.[a.account])
      ? { image: { url: equityChartUrl(s.equity[a.account], s.benchmark?.[a.account]) as string } }
      : {}),
    title: `${a.account} · ${a.rung} · Stop ${a.autonomyStop} · ${a.breaker}${a.locked ? " 🔒" : ""}`,
    color: bandColor(a.breaker),
    description: a.configured
      ? `mode **${a.mode}**${a.modeReason ? ` (${a.modeReason})` : ""}`
      : "_not configured_",
    fields: [
      {
        name: "Equity",
        value: `${usd(a.equityUsd)}${a.account === "PAPER" ? ` (broker ${usd(a.brokerEquityUsd)}, modeled costs ${usd(a.modeledCostUsd)})` : ""}`,
        inline: false,
      },
      { name: "HWM", value: usd(a.hwmUsd), inline: true },
      { name: "Orders today", value: String(a.ordersToday), inline: true },
      {
        name: `Positions (${a.positions.length})`,
        value:
          a.positions.length === 0
            ? "flat"
            : a.positions
                .map(
                  (p) =>
                    `${p.symbol} ${p.qty} @ ${p.avgEntry} · stop ${p.stop}${p.brokerStop ? " 🛡" : " ⚠️"} · tgt ${p.target}${p.state === "EXITING" ? " · exiting" : ""}`,
                )
                .join("\n")
                .slice(0, 1000),
        inline: false,
      },
    ],
  }));
  const regimeLine = s.regimes
    .map(
      (r) =>
        `${r.arena} **${r.posture}**${r.score !== null ? ` ${r.score.toFixed(0)}` : ""}${r.ceiling !== null ? ` · ceiling ${(r.ceiling * 100).toFixed(0)}%` : ""} · ${r.ageMinutes}m${r.fresh ? "" : " ⚠️stale"}`,
    )
    .join("  |  ");
  const paper = s.accounts.find((a) => a.account === "PAPER" && a.configured);
  const components: DiscordMessage["components"] = paper
    ? [
        {
          type: 1,
          components: [
            paper.mode === "PAUSED"
              ? { type: 2, style: 3, label: "Resume PAPER entries", custom_id: "resume:PAPER" }
              : { type: 2, style: 2, label: "Pause PAPER entries", custom_id: "pause:PAPER" },
            { type: 2, style: 4, label: "Flatten PAPER…", custom_id: "flatten:PAPER" },
          ],
        },
      ]
    : [];
  return {
    components,
    content:
      `🧠 **Savant** · pulse ${age} · budget **${s.budget.mode}** (${s.budget.worst.resource} ${(s.budget.worst.fraction * 100).toFixed(0)}%) · journal #${s.journalHead.seq}${s.outboxPending > 0 ? ` (${s.outboxPending} unflushed)` : ""}` +
      (regimeLine ? `\n🌐 ${regimeLine}` : ""),
    embeds,
  };
}

/** Informational contract card for #court. No buttons: execution never waits on a human (ADR-024). */
export function contractCard(k: DecisionContract): DiscordMessage {
  return {
    embeds: [
      {
        title: `⚖️ ${k.symbol} · ${k.strategy_id} · ${k.origin}`,
        color: COLORS.cyan,
        description: k.thesis_summary,
        fields: [
          { name: "Entry zone", value: `${k.entry_plan.zone_low} – ${k.entry_plan.zone_high}`, inline: true },
          { name: "Stop", value: k.invalidation_criteria.stop_price, inline: true },
          { name: "Target", value: k.entry_plan.targets.join(" / "), inline: true },
          { name: "Bear case", value: k.bear_case_brief.slice(0, 1000), inline: false },
        ],
        footer: { text: `contract ${k.contract_id}` },
      },
    ],
  };
}

const postureColor = (p: string) =>
  p === "NEW_ENTRY_ALLOWED" ? COLORS.green : p === "REDUCE_ONLY" ? COLORS.yellow : COLORS.red;

/** Posture card for #pulse-and-briefs (crypto every 4 h, equities pre-open/post-close). */
export function postureCard(b: Batch, previous: string | null): DiscordMessage {
  const p = b.posture;
  if (!p) return { content: `${b.job}: ${b.items.length} item(s)` };
  const changed = previous !== null && previous !== p.posture ? ` (was ${previous})` : "";
  return {
    embeds: [
      {
        title: `${p.arena === "CRYPTO" ? "🪙 Crypto regime" : "📊 Equity posture"} · ${p.posture}${changed}`,
        color: postureColor(p.posture),
        description: p.summary,
        fields: [
          { name: "Score", value: `${p.score.toFixed(1)} / 100`, inline: true },
          {
            name: "Exposure ceiling",
            value: p.ceiling === null ? "—" : `${(p.ceiling * 100).toFixed(0)}%`,
            inline: true,
          },
          { name: "Confidence", value: p.confidence ?? "—", inline: true },
          ...b.items.slice(0, 6).map((i) => ({
            name: i.skill_id,
            value: String((i.payload as { headline?: unknown }).headline ?? "ok").slice(0, 200),
            inline: false,
          })),
        ],
        footer: {
          text: `${b.job} · produced ${new Date(b.produced_at).toISOString()}${b.run_url ? " · GitHub Actions" : ""}`,
        },
        timestamp: new Date(b.produced_at).toISOString(),
      },
    ],
  };
}

/** #world-intel card for a Tier 1 promotion. */
export function intelCard(
  it: TriageItem,
  d: { material: number; direction: string; escalate: number },
  payload: Record<string, unknown>,
): DiscordMessage {
  const arrow = d.direction === "up" ? "📈" : d.direction === "down" ? "📉" : "↔️";
  const url = typeof payload.url === "string" && payload.url.startsWith("https://") ? payload.url : null;
  return {
    embeds: [
      {
        title: `${arrow} ${it.symbols.slice(0, 4).join(", ") || it.kind} · P(material) ${d.material.toFixed(2)} · priority ${d.escalate.toFixed(1)}/3`,
        color: d.direction === "up" ? COLORS.green : d.direction === "down" ? COLORS.red : COLORS.cyan,
        description: `${it.headline.slice(0, 300)}${url ? `\n${url}` : ""}`,
        footer: {
          text: `${it.kind} · ${it.source} · ${it.ageMinutes}m old · Tier 1 clef-flash → Tier 2 queue`,
        },
      },
    ],
  };
}

export interface CourtSession {
  symbol: string;
  arena: string;
  catalyst: { headline: string; source: string; url: string | null; kind: string };
  bid: number;
  atr: number;
  facts?: Record<string, string | number> | null;
  kronos?: string | null;
  research?: Dossier | null;
  bull?: {
    thesis: string;
    setup?: string;
    entry_low: number;
    entry_high: number;
    stop: number;
    targets: number[];
    conviction: number;
    horizon_hours: number;
    receipts?: string[];
    by: string;
  };
  bear?: { fatal_flaws: string[]; kill_criteria: string[]; lethality: number; brief?: string; by: string };
  rebuttal?: {
    rebuttal: string;
    concessions: string[];
    still_long: boolean;
    revised_conviction: number;
    by: string;
  };
  panel?: SeatOpinion[];
  synth?: {
    winProb: number;
    calibrated: number;
    bearLethality: number;
    regimeFit: number;
    suitability100: number;
  };
  contractId?: string;
  verdict?: string;
  ok?: boolean;
}

const bar = (p: number) =>
  `${"█".repeat(Math.round(p * 10))}${"░".repeat(10 - Math.round(p * 10))} ${(p * 100).toFixed(0)}%`;
const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const model = (by: string) => `\`${by.split("/").slice(1).join("/") || by}\``;
const STANCE: Record<string, string> = { support: "🟢 SUPPORT", oppose: "🔴 OPPOSE", abstain: "⚪ ABSTAIN" };

/**
 * #bull-vs-bear-court transcript (ADR-044): one message, one embed per stage of the hearing — the docket, the bull's
 * opening, the bear's cross-examination, the bull's rebuttal, the expert panel and the ruling. Kept under Discord's
 * 6,000-character message limit by trimming the longest fields first.
 */
/** ADR-051: the research desk's briefing as one compact embed inside the court transcript (budget ≈ 1,300 chars). */
function researchBriefEmbed(d: Dossier) {
  const mark = { BULL: "🟢", BEAR: "🔴", NEUTRAL: "⚪" } as const;
  const top = [...d.findings]
    .sort((a, b) => Number(b.verified) - Number(a.verified))
    .slice(0, 4)
    .map(
      (f) =>
        `${mark[f.stance]} ${cut(f.claim, 150)} *(${f.published ?? "undated"}, [${hostOf(f.source_url)}](${f.source_url}))*`,
    )
    .join("\n");
  const next = d.catalysts
    .slice(0, 3)
    .map((c) => `**${c.date ?? "date?"}** ${cut(c.event, 90)}`)
    .join(" · ");
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (top) fields.push({ name: "Exhibits from the web", value: cut(top, 900) });
  if (next) fields.push({ name: "📅 On the calendar", value: cut(next, 320) });
  const counts = { BULL: 0, BEAR: 0, NEUTRAL: 0 };
  for (const f of d.findings) counts[f.stance] += 1;
  const a = d.agent;
  return {
    title: `📚 Research desk briefing — ${d.findings.length} findings · 🟢 ${counts.BULL} · 🔴 ${counts.BEAR}`,
    description: cut(d.summary || "(no summary)", 420),
    color: COLORS.cyan,
    fields,
    footer: {
      text: cut(
        `${a.steps} steps · ${a.tool_calls} tool calls · ${a.pages_read} pages read · ${a.models[0] ?? "?"} · unverified web text, cite as res_*`,
        200,
      ),
    },
  };
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

/** ADR-051: the research desk's dossier, posted to the court channel before the hearing. */
export function dossierCard(d: Dossier): DiscordMessage {
  const mark = { BULL: "🟢", BEAR: "🔴", NEUTRAL: "⚪" } as const;
  const findings = d.findings
    .slice(0, 8)
    .map(
      (f) =>
        `${mark[f.stance]} ${cut(f.claim, 220)} — *${f.published ?? "undated"}* [${cut(f.source_title || "source", 40)}](${f.source_url})${f.verified ? "" : " ·headline only"}`,
    )
    .join("\n");
  const cats = d.catalysts
    .slice(0, 5)
    .map((c) => `• **${c.date ?? "date?"}** ${cut(c.event, 160)}`)
    .join("\n");
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (d.thesis)
    fields.push({
      name: `${{ INTACT: "✅", WEAKENED: "⚠️", BROKEN: "💥" }[d.thesis.status]} Thesis ${d.thesis.status}`,
      value: cut(d.thesis.reason || "—", 400),
    });
  if (d.market_context) fields.push({ name: "🌍 Market today", value: cut(d.market_context, 500) });
  if (d.catalyst_trace?.story)
    fields.push({
      name: `🧵 Where the story came from${d.catalyst_trace.first_reported ? ` (first ${d.catalyst_trace.first_reported})` : ""}`,
      value: cut(
        `${d.catalyst_trace.story}${d.catalyst_trace.original_source_url ? ` [origin](${d.catalyst_trace.original_source_url})` : ""}`,
        500,
      ),
    });
  if (d.cruxes.length)
    fields.push({
      name: "🎯 Cruxes",
      value: cut(d.cruxes.map((c) => `• ${c.question} → ${c.answer ?? "**open**"}`).join("\n"), 700),
    });
  if (d.flags.length) fields.push({ name: "🚩 Filing flags", value: cut(d.flags.join(" · "), 300) });
  if (cats) fields.push({ name: "📅 What's coming", value: cut(cats, 900) });
  if (d.bull_case) fields.push({ name: "🐂 Case for", value: cut(d.bull_case, 500), inline: true });
  if (d.bear_case) fields.push({ name: "🐻 Case against", value: cut(d.bear_case, 500), inline: true });
  if (d.risks.length)
    fields.push({ name: "⚠️ Risks", value: cut(d.risks.map((r) => `• ${r}`).join("\n"), 600) });
  if (d.open_questions.length)
    fields.push({
      name: "❓ Could not verify",
      value: cut(d.open_questions.map((q) => `• ${q}`).join("\n"), 400),
    });
  const a = d.agent;
  return {
    embeds: [
      {
        title: `${{ fast: "⚡", deep: "🔬", watch: "👁" }[d.stage]} Research desk (${d.stage}) — ${d.symbol}`,
        description: cut(`${d.summary || "(no summary)"}\n\n**Key findings**\n${findings || "none"}`, 3500),
        color: COLORS.cyan,
        fields,
        footer: {
          text: cut(
            `${a.steps} steps · ${a.tool_calls} tool calls · ${a.pages_read} pages read · ${Math.round(a.wall_s)} s${a.compactions ? ` · compacted ${a.compactions}×` : ""} · ${a.models.join(", ")} · web text is unverified`,
            300,
          ),
        },
      },
    ],
  };
}

/** ADR-061: the weekly book review card (#governor). */
export function bookCard(account: string, b: BookSummary): DiscordMessage {
  const usd2 = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
  const rows = b.lines
    .map(
      (l) =>
        `• **${l.symbol}** ${usd2(l.notionalUsd)} · ${l.r >= 0 ? "+" : ""}${l.r} R · ${Math.round(l.horizonFraction * 100)}% of horizon${l.stagnant ? " · 💤 stagnant" : ""} · β BTC ${l.betaBtc ?? "—"} / SPY ${l.betaSpy ?? "—"} · worst 5d ${l.worst5d === null ? "—" : `${(l.worst5d * 100).toFixed(1)}%`}`,
    )
    .join("\n");
  return {
    embeds: [
      {
        title: `📒 Book review — ${account}`,
        description: cut(rows || "Flat: no positions.", 3000),
        color: COLORS.cyan,
        fields: [
          { name: "Gross / equity", value: `${usd2(b.grossUsd)} / ${usd2(b.equityUsd)}`, inline: true },
          {
            name: "By arena",
            value: JSON.stringify(b.arenaShare).replace(/[{}"]/g, "") || "—",
            inline: true,
          },
          {
            name: "Net β (USD)",
            value: `BTC ${usd2(b.netBetaBtcUsd)} · SPY ${usd2(b.netBetaSpyUsd)}`,
            inline: true,
          },
          {
            name: "Crash replay",
            value: `${usd2(b.stressLossUsd)} if every holding repeated its worst 5 days`,
            inline: true,
          },
          {
            name: "Closest pair",
            value: b.maxPairCorr ? `${b.maxPairCorr.a} ~ ${b.maxPairCorr.b} ρ ${b.maxPairCorr.corr}` : "—",
            inline: true,
          },
        ],
        footer: { text: "Measurement only — the risk engine's caps are what limit the book." },
      },
    ],
  };
}

/** ADR-059: a re-underwriting hearing's outcome, posted to the court channel. */
export function reviewCard(
  symbol: string,
  wires: string[],
  d: { action: string; why: string; thesisAlive: number | null; killFired: number | null; pExit: number },
  r: number,
): DiscordMessage {
  const icon = { HOLD: "🟢", TIGHTEN: "🟡", EXIT: "🔴" }[d.action] ?? "⚪";
  return {
    embeds: [
      {
        title: `🔁 Re-underwriting — ${symbol}: ${icon} ${d.action}`,
        description: cut(
          `**Why it was reviewed**\n${wires.map((w) => `• ${w}`).join("\n")}\n\n**Ruling** ${d.why}`,
          1800,
        ),
        color: d.action === "EXIT" ? COLORS.red : d.action === "TIGHTEN" ? COLORS.yellow : COLORS.green,
        fields: [
          { name: "Now", value: `${r >= 0 ? "+" : ""}${r.toFixed(2)} R`, inline: true },
          {
            name: "Thesis alive",
            value: d.thesisAlive === null ? "—" : `${Math.round(d.thesisAlive * 100)}%`,
            inline: true,
          },
          {
            name: "Kill fired",
            value: d.killFired === null ? "—" : `${Math.round(d.killFired * 100)}%`,
            inline: true,
          },
        ],
        footer: { text: "Clef 27B chose the action; code sets every price. Stops only move up." },
      },
    ],
  };
}

export function courtSessionCard(s: CourtSession): DiscordMessage {
  type Field = { name: string; value: string; inline?: boolean };
  type E = {
    title: string;
    description?: string;
    color: number;
    fields?: Field[];
    footer?: { text: string };
  };
  const embeds: E[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  const docket: Field[] = [
    {
      name: "Market",
      value: `bid **${s.bid}**\nATR14 ${s.atr.toPrecision(4)} (${pct(s.atr / s.bid)})`,
      inline: true,
    },
    { name: "Source", value: `${s.catalyst.kind} · ${cut(s.catalyst.source, 40)}`, inline: true },
  ];
  const facts = Object.entries(s.facts ?? {});
  if (facts.length > 0)
    docket.push({
      name: "🔎 Facts on the record (Clairic)",
      value: facts.map(([k, v]) => `\`${k}\` ${v}`).join(" · "),
    });
  if (s.kronos) docket.push({ name: "🔮 Kronos (low confidence)", value: cut(s.kronos, 300) });
  embeds.push({
    title: `⚖️ Savant COURT — ${s.symbol} (${s.arena})`,
    description: `**Matter before the court**\n> ${cut(s.catalyst.headline, 300)}${s.catalyst.url ? `\n[source](${s.catalyst.url})` : ""}`,
    color: COLORS.cyan,
    fields: docket,
  });
  if (s.research) embeds.push(researchBriefEmbed(s.research));

  if (s.bull) {
    const b = s.bull;
    const rr = (b.targets[0] ?? b.entry_high) - b.entry_high;
    const risk = b.entry_low - b.stop;
    embeds.push({
      title: `🐂 Opening statement — Bull Advocate`,
      description: cut(b.thesis, 700),
      color: COLORS.green,
      fields: [
        {
          name: "Proposed trade",
          value: `entry ${b.entry_low}–${b.entry_high}\nstop ${b.stop}\ntargets ${b.targets.join(" / ")}`,
          inline: true,
        },
        {
          name: "Terms",
          value: `${b.setup ?? "—"} · ${b.horizon_hours}h\nreward:risk ${risk > 0 ? (rr / risk).toFixed(2) : "—"}\nconviction ${b.conviction}/10`,
          inline: true,
        },
        ...(b.receipts?.length
          ? [{ name: "Exhibits", value: cut(b.receipts.map((r) => `\`${r}\``).join(" "), 300) }]
          : []),
      ],
      footer: { text: `argued by ${b.by}` },
    });
  }
  if (s.bear) {
    embeds.push({
      title: `🐻 Cross-examination — Bear Prosecutor · lethality ${(s.bear.lethality * 100).toFixed(0)}%`,
      description: s.bear.fatal_flaws
        .slice(0, 4)
        .map((f, i) => `**${i + 1}.** ${cut(f, 260)}`)
        .join("\n"),
      color: COLORS.red,
      fields: [
        {
          name: "The bull is wrong if…",
          value: cut(
            s.bear.kill_criteria
              .slice(0, 3)
              .map((k) => `• ${k}`)
              .join("\n"),
            600,
          ),
        },
      ],
      footer: { text: `prosecuted by ${s.bear.by}` },
    });
  }
  if (s.rebuttal) {
    const r = s.rebuttal;
    embeds.push({
      title: `🐂 Rebuttal — ${r.still_long ? "the bull stands firm" : "the bull withdraws"}`,
      description: cut(r.rebuttal, 900),
      color: r.still_long ? COLORS.green : COLORS.orange,
      fields: [
        ...(r.concessions.length
          ? [
              {
                name: "Conceded",
                value: cut(
                  r.concessions
                    .slice(0, 3)
                    .map((c) => `• ${c}`)
                    .join("\n"),
                  500,
                ),
              },
            ]
          : []),
        {
          name: "Conviction after cross",
          value: `${s.bull?.conviction ?? "?"} → **${r.revised_conviction}**/10`,
          inline: true,
        },
      ],
      footer: { text: `answered by ${r.by}` },
    });
  }
  if (s.panel && s.panel.length > 0) {
    const tally = (k: string) => s.panel?.filter((p) => p.stance === k).length ?? 0;
    embeds.push({
      title: `🎓 Expert panel — ${tally("support")} for · ${tally("oppose")} against · ${tally("abstain")} abstain`,
      color: COLORS.yellow,
      fields: s.panel.map((p) => ({
        name: `${p.emoji} ${p.title} — ${STANCE[p.stance] ?? p.stance} (${(p.confidence * 100).toFixed(0)}%)`,
        value: cut(`*${p.headline}*\n${p.points.map((x) => `• ${x}`).join("\n")}\n— ${model(p.by)}`, 1000),
      })),
    });
  }
  const ruling: Field[] = [];
  if (s.synth)
    ruling.push({
      name: "Clef 27B, presiding",
      value: [
        `\`P(win) raw   ${bar(s.synth.winProb)}\``,
        `\`P(win) calib ${bar(s.synth.calibrated)}\``,
        `\`Bear right   ${bar(s.synth.bearLethality)}\``,
        `\`Regime fit   ${bar(s.synth.regimeFit)}\``,
        `\`Suitability  ${bar(s.synth.suitability100 / 100)}\``,
      ].join("\n"),
    });
  ruling.push({ name: "Judgment of the risk engine", value: cut(s.verdict ?? "—", 1000) });
  embeds.push({
    title: s.ok ? "🔨 RULING — trade approved" : "🔨 RULING — no trade",
    color: s.ok ? COLORS.green : s.synth ? COLORS.yellow : COLORS.red,
    fields: ruling,
    footer: {
      text: `${s.contractId ? `contract ${s.contractId}` : "no contract"} · models argue, code computes, the risk engine decides`,
    },
  });

  // Discord: ≤ 1024 per field value, ≤ 4096 per description, ≤ 6000 characters per message.
  for (const e of embeds) for (const f of e.fields ?? []) f.value = cut(f.value, 1024);
  const size = () =>
    embeds.reduce(
      (n, e) =>
        n +
        e.title.length +
        (e.description?.length ?? 0) +
        (e.footer?.text.length ?? 0) +
        (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0),
      0,
    );
  while (size() > 5800) {
    let longest: { get: () => string; set: (v: string) => void } | null = null;
    let len = 0;
    for (const e of embeds) {
      if ((e.description?.length ?? 0) > len) {
        len = e.description?.length ?? 0;
        longest = { get: () => e.description ?? "", set: (v) => (e.description = v) };
      }
      for (const f of e.fields ?? [])
        if (f.value.length > len) {
          len = f.value.length;
          longest = { get: () => f.value, set: (v) => (f.value = v) };
        }
    }
    if (!longest || len < 80) break;
    longest.set(cut(longest.get(), Math.floor(len * 0.8)));
  }
  return { embeds };
}
