import { useState } from "react";
import { command } from "./api.ts";
import { Md } from "./feed.tsx";

/**
 * ASK (ADR-071): the questions you can put to the robot, in the app (Discord's slash commands are optional now).
 * WHY and UNIVERSE answer at once; COURT, ROAST and BOOK run in the background and post their card to the FEED.
 */
const SYMBOL = /^[A-Z0-9.]{1,10}(\/USD)?$/;

const ACTIONS = [
  {
    id: "why",
    label: "WHY",
    needs: "symbol",
    help: "Why did the robot do (or not do) something with this symbol? Its own decision trail, nothing invented.",
  },
  {
    id: "court",
    label: "COURT",
    needs: "symbol",
    help: "Convene a full bull-vs-bear hearing on this symbol now. Paper only; every gate still applies.",
  },
  {
    id: "roast",
    label: "ROAST MY IDEA",
    needs: "thesis",
    help: "Write your own trade idea; the court argues it out and scores it. Never trades.",
  },
  {
    id: "book",
    label: "BOOK REVIEW",
    needs: null,
    help: "How the open positions fit together right now: risk, overlap, what to watch.",
  },
  {
    id: "universe",
    label: "WATCHLIST",
    needs: null,
    help: "Which symbols the robot is watching and trading, and why.",
  },
] as const;

export function AskPage({ goFeed }: { goFeed: () => void }) {
  const [sym, setSym] = useState("");
  const [thesis, setThesis] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ q: string; text: string; ok: boolean; later: boolean } | null>(null);
  const symOk = SYMBOL.test(sym.trim());
  const run = async (id: string) => {
    setBusy(id);
    try {
      const r = await command(id, { symbol: sym.trim(), thesis: thesis.trim() });
      setAnswer({
        q: `${id.toUpperCase()}${["why", "court", "roast"].includes(id) ? ` ${sym.trim()}` : ""}`,
        text: r.message,
        ok: r.ok,
        later: r.ok && ["court", "roast", "book"].includes(id),
      });
    } catch (e) {
      setAnswer({
        q: id.toUpperCase(),
        text: e instanceof Error ? e.message : String(e),
        ok: false,
        later: false,
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="ask">
      <div className="ask-inputs">
        <label className="ask-field">
          <span className="label dim">SYMBOL</span>
          <input
            className="field"
            placeholder="BTC/USD or NVDA"
            value={sym}
            onChange={(e) => setSym(e.target.value.toUpperCase())}
            aria-invalid={sym !== "" && !symOk}
          />
        </label>
        <label className="ask-field grow">
          <span className="label dim">YOUR IDEA (FOR ROAST)</span>
          <textarea
            className="field"
            placeholder="e.g. ETH breaks out this week because the ETF flows turned positive"
            value={thesis}
            onChange={(e) => setThesis(e.target.value)}
            maxLength={600}
          />
        </label>
      </div>
      <div className="ask-actions">
        {ACTIONS.map((a) => {
          const ready = a.needs === null || (symOk && (a.needs === "symbol" || thesis.trim().length >= 10));
          return (
            <div key={a.id} className="ask-action">
              <button
                type="button"
                className="pb wide"
                disabled={!ready || busy !== null}
                onClick={() => void run(a.id)}
              >
                <span className={ready ? "on-cyan" : ""}>{busy === a.id ? "…" : a.label}</span>
              </button>
              <p className="cost">{a.help}</p>
            </div>
          );
        })}
      </div>
      {answer && (
        <section className={`answer ${answer.ok ? "" : "err"}`} aria-live="polite">
          <h4>{answer.q}</h4>
          <div className="answer-text">
            <Md text={answer.text} />
          </div>
          {answer.later && (
            <button type="button" className="chip" onClick={goFeed}>
              THE FULL CARD WILL APPEAR IN THE FEED →
            </button>
          )}
        </section>
      )}
    </div>
  );
}
