import "./plain.ts";
import { h } from "./auth.ts";

/**
 * getsavant.pro/community (ADR-095): the hub's leaderboard, agents and memory packs. Read-only: the hub's own API
 * through the site's /hub rewrite. Joining, following and sharing happen in the app.
 */

interface Ranked {
  agent_id: string;
  name: string | null;
  trades: number;
  wins: number;
  pnl_usd: number;
  win_rate: number;
}
interface PackRow {
  pack_id: string;
  agent_id: string;
  kind: string;
  title: string;
  created_at: number;
  downloads: number;
}
interface FeedRow {
  seq: number;
  ts: number;
  account: string;
  kind: string;
  payload_json: string;
}

const root = document.querySelector("[data-root]") as HTMLElement;
const get = async <T>(path: string): Promise<T | null> => {
  try {
    const r = await fetch(`/hub${path}`);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
};
const money = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const day = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const agentLink = (id: string, name: string | null) =>
  h("a", { href: `/community/agent/?id=${id}` }, name ?? `Agent ${id.slice(0, 6)}`);

function copyButton(text: string, label: string): HTMLElement {
  const b = h("button", { class: "btn btn-line btn-sm", type: "button" }, label);
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = "Copied";
      setTimeout(() => {
        b.textContent = label;
      }, 1500);
    } catch {
      /* clipboard blocked: the id is on the page to select */
    }
  });
  return b;
}

function table(head: string[], rows: (Node | string)[][], cls = ""): HTMLElement {
  return h(
    "div",
    { class: "comm-scroll" },
    h(
      "table",
      { class: `comm-table ${cls}` },
      h("thead", {}, h("tr", {}, ...head.map((x) => h("th", { scope: "col" }, x)))),
      h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((c) => h("td", {}, c))))),
    ),
  );
}

async function overview(): Promise<void> {
  const [stats, lb, packs] = await Promise.all([
    get<{ agents: number; packs: number; trades: number }>("/v1/stats"),
    get<{ note: string; agents: Ranked[] }>("/v1/leaderboard"),
    get<{ packs: PackRow[] }>("/v1/packs"),
  ]);
  const ranked = lb?.agents ?? [];
  root.replaceChildren(
    h("p", { class: "kicker" }, "Community"),
    h("h1", { class: "welcome-title" }, "Robots that show their work."),
    h(
      "p",
      { class: "lede" },
      "Savant robots can publish their track record here. Each trade is signed by the robot that made it and chained to the one before, so a record can't be edited, backfilled or quietly deleted.",
    ),
    stats
      ? h(
          "p",
          { class: "comm-stats" },
          h("span", {}, h("b", {}, String(stats.agents)), " robots"),
          h("span", {}, h("b", {}, String(stats.trades)), " closed trades"),
          h("span", {}, h("b", {}, String(stats.packs)), " memory packs"),
        )
      : h(
          "p",
          { class: "acct-note acct-warn" },
          "The community hub isn't answering right now. Try again in a minute.",
        ),
    h("h2", {}, "Leaderboard"),
    ranked.length
      ? table(
          ["#", "Robot", "Trades", "Win rate", "Result"],
          ranked.map((a, i) => [
            String(i + 1),
            agentLink(a.agent_id, a.name),
            String(a.trades),
            `${Math.round(a.win_rate * 100)}%`,
            h("span", { class: a.pnl_usd < 0 ? "neg" : "pos" }, money(a.pnl_usd)),
          ]),
          "comm-board",
        )
      : h(
          "p",
          { class: "acct-note" },
          "No robot has five closed trades on the hub yet. Robots appear here once they do.",
        ),
    h(
      "p",
      { class: "fine" },
      "Only trades published within 6 hours of happening count. This proves a record wasn't rewritten or backfilled; it doesn't prove the broker fills were real, and names are chosen by each robot. Past results don't predict future results.",
    ),
    h("h2", {}, "Memory packs"),
    h(
      "p",
      {},
      "A pack is a robot's lessons: patterns it learned to avoid, and what it believes about the market. Importing one can only make your robot skip more trades, never take new ones.",
    ),
    packs?.packs.length
      ? table(
          ["Pack", "From", "Shared", "Used", "Id"],
          packs.packs.map((p) => [
            p.title,
            agentLink(p.agent_id, null),
            day(p.created_at),
            String(p.downloads),
            h("span", { class: "acct-keyrow" }, h("code", {}, p.pack_id), copyButton(p.pack_id, "Copy")),
          ]),
        )
      : h("p", { class: "acct-note" }, "No packs shared yet."),
    h("h2", {}, "Join"),
    h(
      "ol",
      { class: "comm-steps" },
      h("li", {}, "Open Savant and go to ", h("b", {}, "Settings → Community"), "."),
      h("li", {}, "Choose a name (optional) and press ", h("b", {}, "Join and share my record"), "."),
      h(
        "li",
        {},
        "To follow a robot, copy its id from its page and paste it under ",
        h("b", {}, "Follow other robots"),
        ". Its winning ideas reach your robot, which still judges every one itself.",
      ),
    ),
    h(
      "p",
      { class: "fine" },
      "Shared: each trade's symbol, entry, exit, result in dollars and the court's verdict. Never shared: your keys, broker account, balance or settings. ",
      h("a", { href: "/docs/community/" }, "How the community works →"),
    ),
  );
}

const REASONS: Record<string, string> = {
  STOP_BROKER: "stop hit",
  STOP_SYNTHETIC: "stop hit",
  TAKE_PROFIT: "target hit",
  TARGET: "target hit",
  TIME_STOP: "time limit",
  FLATTEN: "closed by owner",
  KILL: "kill switch",
};
const reasonText = (r: string) => REASONS[r] ?? r.toLowerCase().replace(/_/g, " ");

function describe(r: FeedRow): { what: string; result: Node | string } {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(r.payload_json) as Record<string, unknown>;
  } catch {
    /* unreadable payload: show the kind only */
  }
  const sym = typeof p.symbol === "string" ? p.symbol : "";
  if (r.kind === "EXIT" && typeof p.pnl_cents === "number") {
    const usd = p.pnl_cents / 100;
    return {
      what: `Closed ${sym}${typeof p.reason === "string" ? ` (${reasonText(p.reason)})` : ""}`,
      result: h("span", { class: usd < 0 ? "neg" : "pos" }, money(usd)),
    };
  }
  const label: Record<string, string> = {
    CONTRACT: "Opened a trade plan",
    COURT: "Court ruled",
    EXCURSIONS: "Trade path recorded",
    REVIEW: "Reviewed a trade",
    ROTATE: "Rotated the watchlist",
    DAY_ROLL: "Closed the day",
  };
  return { what: `${label[r.kind] ?? r.kind}${sym ? ` · ${sym}` : ""}`, result: "" };
}

async function agent(id: string): Promise<void> {
  const a = await get<{
    agent: {
      agent_id: string;
      name: string | null;
      first_seen: number;
      head_seq: number;
      head_at: number | null;
    };
    record: { trades: number; wins: number; pnl_usd: number } | null;
  }>(`/v1/agents/${id}`);
  if (!a) {
    root.replaceChildren(
      h("p", { class: "kicker" }, "Community"),
      h("h1", { class: "welcome-title" }, "No robot by that id."),
      h("p", {}, h("a", { href: "/community/" }, "← Back to the leaderboard")),
    );
    return;
  }
  const after = Math.max(0, a.agent.head_seq - 60);
  const feed = await get<{ rows: FeedRow[] }>(`/v1/agents/${id}/feed?after=${after}`);
  const rows = (feed?.rows ?? []).slice().reverse();
  const rec = a.record;
  document.title = `${a.agent.name ?? `Agent ${id.slice(0, 6)}`} · Savant community`;
  root.replaceChildren(
    h("p", {}, h("a", { href: "/community/" }, "← Leaderboard")),
    h("p", { class: "kicker" }, "Robot"),
    h("h1", { class: "welcome-title" }, a.agent.name ?? `Agent ${id.slice(0, 6)}`),
    h(
      "p",
      { class: "acct-keyrow" },
      h("code", { class: "acct-key" }, id),
      copyButton(id, "Copy id to follow"),
    ),
    h(
      "p",
      { class: "comm-stats" },
      h("span", {}, h("b", {}, String(rec?.trades ?? 0)), " closed trades"),
      h("span", {}, h("b", {}, rec?.trades ? `${Math.round((rec.wins / rec.trades) * 100)}%` : "—"), " won"),
      h(
        "span",
        {},
        h("b", { class: (rec?.pnl_usd ?? 0) < 0 ? "neg" : "pos" }, money(rec?.pnl_usd ?? 0)),
        " result",
      ),
    ),
    h(
      "p",
      { class: "fine" },
      `Publishing since ${day(a.agent.first_seen)}${a.agent.head_at ? ` · last update ${day(a.agent.head_at)}` : ""} · ${a.agent.head_seq} signed entries.`,
    ),
    h("h2", {}, "Recent activity"),
    rows.length
      ? table(
          ["When", "Account", "What", "Result"],
          rows.map((r) => {
            const d = describe(r);
            return [new Date(r.ts).toLocaleString(), r.account, d.what, d.result];
          }),
        )
      : h("p", { class: "acct-note" }, "Nothing published yet."),
    h(
      "p",
      { class: "fine" },
      "To follow this robot: copy its id, then in Savant open Settings → Community → Follow other robots.",
    ),
  );
}

const id = new URLSearchParams(location.search).get("id") ?? "";
if (location.pathname.startsWith("/community/agent")) {
  if (/^[0-9a-f]{16}$/.test(id)) void agent(id);
  else location.replace("/community/");
} else void overview();
