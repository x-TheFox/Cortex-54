import type { FeedItem, StatusView } from "./api.ts";
import { useResource } from "./api.ts";
import type { Ecam } from "./ecam.ts";
import { ago, usd } from "./instruments.tsx";

/**
 * TODAY (ADR-073): the cockpit in one plain sentence, for people who don't read gauges. What it holds, how the money
 * is doing, the last thing it did, and whether anything needs you. Computed from the same data as the cockpit.
 */
function headline(f: FeedItem | undefined): string | null {
  if (!f) return null;
  const e = f.msg.embeds?.[0];
  const t =
    (e?.title ?? f.msg.content ?? "")
      .replace(/\*\*|`/g, "")
      .split("\n")[0]
      ?.trim() ?? "";
  return t ? t.slice(0, 120) : null;
}

export function Today({
  s,
  e,
  now,
  goFeed,
}: {
  s: StatusView;
  e: Ecam | null;
  now: number;
  goFeed: () => void;
}) {
  const feed = useResource<FeedItem[]>("/api/feed?limit=8", 30_000);
  const a =
    s.accounts.find((x) => x.account === "PAPER" && x.configured) ?? s.accounts.find((x) => x.configured);
  if (!a) return null;
  const start = a.startUsd ?? 54; // where the account started (ADR-081), as on the cockpit's equity line
  const pnl = a.equityUsd !== null ? a.equityUsd - start : null;
  const held = a.positions.map((p) => p.symbol);
  // the latest thing worth reading: skip housekeeping (journal anchors, day rolls)
  const last = feed.data?.find((f) => !/^🔗/.test(headline(f) ?? "🔗"));
  const needs = e?.warnings[0] ?? e?.cautions[0] ?? null;
  return (
    <section
      className={`today ${needs ? (e?.warnings.length ? "warn" : "caut") : ""}`}
      aria-label="Today in plain words"
    >
      <p>
        {a.equityUsd !== null ? (
          <>
            The robot has <b>{usd(a.equityUsd)}</b>
            {pnl !== null && (
              <span className={pnl >= 0 ? "green" : "red"}>
                {" "}
                ({pnl >= 0 ? "+" : "−"}
                {usd(Math.abs(pnl))} since it started with {usd(start)})
              </span>
            )}
            .{" "}
          </>
        ) : (
          "Connecting to the account… "
        )}
        {held.length === 0 ? "It holds nothing right now." : `It holds ${held.join(", ")}.`}{" "}
        {a.mode === "PAUSED" ? "New trades are paused. " : ""}
        {headline(last) && (
          <>
            Latest:{" "}
            <button type="button" className="linkish" onClick={goFeed}>
              {headline(last)}
            </button>{" "}
            <span className="dimtext">({ago(last?.ts ?? null, now)})</span>.{" "}
          </>
        )}
        {needs ? (
          <b className={e?.warnings.length ? "red" : "amber"}>Needs a look: {needs.title.toLowerCase()}.</b>
        ) : (
          <span className="green">Nothing needs you.</span>
        )}
      </p>
    </section>
  );
}
