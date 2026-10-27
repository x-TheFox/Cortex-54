import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AccountView,
  command,
  consumeLoginHash,
  type SettingsView,
  type StatusView,
  useNow,
  useResource,
} from "./api.ts";
import { AskPage } from "./ask.tsx";
import { drawdown, ecam } from "./ecam.ts";
import { FeedPage } from "./feed.tsx";
import { FcstPage } from "./forecast.tsx";
import { GUIDE_SEEN_KEY, Guide } from "./guide.tsx";
import { ago, Dial, heat, pct, Trend, usd, utc } from "./instruments.tsx";
import { Onboarding } from "./onboarding.tsx";
import { AccountPanel, CourtPanel } from "./overhead.tsx";
import { AcctPage, FunnelPage, GovPage, MemPage, OptPage, StsPage } from "./pages.tsx";
import { SettingsPage } from "./settings.tsx";
import { Today } from "./today.tsx";

// ADR-071: the app is the main dashboard; FEED and ASK carry everything Discord used to, SET configures it all.
const PAGES = [
  { id: "ACCT", title: "ACCOUNTS" },
  { id: "FEED", title: "FEED · EVERYTHING THE ROBOT SAYS" },
  { id: "ASK", title: "ASK THE ROBOT" },
  { id: "FUNNEL", title: "FUNNEL · COURT AND REJECTIONS" },
  { id: "MEM", title: "MEMORY" },
  { id: "OPT", title: "OPTIONS SHADOW LAB" },
  { id: "GOV", title: "GOVERNOR" },
  { id: "STS", title: "STATUS" },
  { id: "FCST", title: "FORECAST · KRONOS VS THE ROBOT" },
  { id: "SET", title: "SETTINGS" },
] as const;
type PageId = (typeof PAGES)[number]["id"];

function readPage(): PageId {
  try {
    const v = localStorage.getItem("cortex.sd");
    if (v && PAGES.some((p) => p.id === v)) return v as PageId;
  } catch {
    /* storage unavailable: default page */
  }
  return "ACCT";
}

function AccountColumn({ a, s }: { a: AccountView; s: StatusView }) {
  if (!a.configured || a.equityUsd === null) {
    const live = a.account === "LIVE";
    return (
      <div className={`acct ${live ? "acct-dormant" : ""}`} data-guide={live ? "live" : undefined}>
        <div className="acct-head">
          <span className="label">{a.account}</span>
          <span className="label dim">{a.account === "LIVE" ? "DORMANT" : "NO DATA"}</span>
        </div>
        <div className={`equity ${live ? "off" : "unknown"}`}>
          <small>$</small>
          {live ? "—" : "XX"}
        </div>
        <div className="dormant">
          {a.account === "LIVE"
            ? "Real money starts after all phases are built, PAPER passes the 30-day gate, a live kill drill, and your RATIFY."
            : "Waiting for the first reconciliation."}
        </div>
      </div>
    );
  }
  const dd = drawdown(a);
  const h = heat(a);
  const pnl = a.hwmUsd !== null ? a.equityUsd - 54 : null;
  return (
    <div className="acct">
      <div className="acct-head">
        <span className="label">
          {a.account} · {a.rung}
        </span>
        <span className="label dim">STOP {a.autonomyStop}</span>
      </div>
      <div data-guide="equity">
        <div className={`equity ${a.breaker === "RED" ? "red" : ""}`}>
          <small>$</small>
          {a.equityUsd.toFixed(2)}
        </div>
        <div className="sub">
          SINCE $54{" "}
          <span className={pnl !== null && pnl < 0 ? "down" : "up"}>
            {pnl === null ? "—" : `${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`}
          </span>
          {"  ·  "}HWM {usd(a.hwmUsd)}
          {a.account === "PAPER" && ` · MODELED COSTS ${usd(a.modeledCostUsd)}`}
        </div>
      </div>
      <div className="dials" data-guide={a.account === "PAPER" ? "dials" : undefined}>
        <Dial label="DRAWDOWN" value={dd} max={0.12} amber={0.03} red={0.1} fmt={(v) => pct(v)} />
        <Dial label="HEAT" value={h} max={0.15} amber={0.09} red={0.12} fmt={(v) => pct(v)} />
        {a.account === "PAPER" && (
          <Dial
            label="FREE TIER"
            value={s.budget.worst.fraction}
            max={1}
            amber={0.7}
            red={0.9}
            fmt={(v) => pct(v, 0)}
          />
        )}
      </div>
      <div data-guide={a.account === "PAPER" ? "trend" : undefined}>
        <Trend
          points={s.equity[a.account]}
          hwm={a.hwmUsd}
          label={`${a.account} equity`}
          bench={s.benchmark?.[a.account]}
        />
      </div>
    </div>
  );
}

export function App() {
  const [boot, setBoot] = useState<"pending" | "ok" | "expired" | "none">("pending");
  useEffect(() => {
    void consumeLoginHash().then(setBoot);
  }, []);
  const st = useResource<StatusView>(boot === "pending" ? null : "/api/state", 15_000);
  const settings = useResource<SettingsView>(boot === "pending" ? null : "/api/settings", 0);
  const [onb, setOnb] = useState<boolean | null>(null);
  // ADR-073: first launch (local mode, not onboarded yet) opens the welcome screen once per load
  useEffect(() => {
    if (onb !== null) return;
    if (settings.data) setOnb(settings.data.managed === "local" && settings.data.onboarded === false);
    else if (settings.error) setOnb(false);
  }, [settings.data, settings.error, onb]);
  const now = useNow(1000);
  const [page, setPageState] = useState<PageId>(readPage);
  const [ackCaut, setAckCaut] = useState<string>("");
  const [ackWarn, setAckWarn] = useState<string>("");
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState(false);
  const called = useRef("");

  const setPage = useCallback((p: PageId) => {
    setPageState(p);
    try {
      localStorage.setItem("cortex.sd", p);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "?") {
        setGuide(true);
        return;
      }
      const i = e.key === "0" ? 9 : Number(e.key) - 1;
      const p = PAGES[i];
      if (p) setPage(p.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPage]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      setBusy(true);
      try {
        const r = await command(name, args);
        setToast({ msg: r.message, err: !r.ok });
      } catch (e) {
        setToast({ msg: e instanceof Error ? e.message : String(e), err: true });
      } finally {
        setBusy(false);
        st.reload();
      }
    },
    [st],
  );

  // local mode is paper-only: no LIVE column, no LIVE controls (a dormant LIVE account there only confuses)
  const local = settings.data?.managed === "local";
  const s = useMemo(
    () =>
      st.data && local
        ? { ...st.data, accounts: st.data.accounts.filter((a) => a.account !== "LIVE") }
        : st.data,
    [st.data, local],
  );
  const e = useMemo(() => (s ? ecam(s, now) : null), [s, now]);
  const warnKey = e ? e.warnings.map((w) => w.id).join(",") : "";
  const cautKey = e ? e.cautions.map((c) => c.id).join(",") : "";
  const warnLit = warnKey !== "" && warnKey !== ackWarn;
  const cautLit = cautKey !== "" && cautKey !== ackCaut;

  // ECAM auto-call: a new warning or caution brings up the system page that explains it (once per new set).
  const alertKey = `${warnKey}|${cautKey}`;
  useEffect(() => {
    if (!e || alertKey === "|" || alertKey === called.current) return;
    called.current = alertKey;
    const first = e.warnings[0] ?? e.cautions[0];
    if (first) setPage(first.page);
  }, [alertKey, e, setPage]);

  // First visit: offer the guide once (it can be reopened any time with GUIDE or "?").
  useEffect(() => {
    if (!s || onb !== false) return; // after onboarding (or on a cloud brain), not on top of it
    try {
      if (!localStorage.getItem(GUIDE_SEEN_KEY)) {
        localStorage.setItem(GUIDE_SEEN_KEY, "1");
        setGuide(true);
      }
    } catch {
      /* storage unavailable: the GUIDE key still works */
    }
  }, [s, onb]);

  if (st.signedOut || boot === "expired") {
    return (
      <main className="cockpit">
        <div className="signin">
          <div className="display">
            <div className="glass">
              <span className="label dim">CORTEX-54 · TERMINAL</span>
              <p className="alert caution">
                <span className="alert-title">
                  {boot === "expired" ? "LOGIN LINK EXPIRED" : "NO SESSION"}
                </span>
              </p>
              <p className="alert-action">OPEN THE DASHBOARD FROM THE CORTEX APP (TRAY → OPEN)</p>
              <p className="alert-action">OR RUN `cortex link` · OR /terminal IN DISCORD</p>
              <p className="alert-action">EACH LINK WORKS ONCE, FOR 10 MINUTES</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const pulseAge = s?.lastPulseAt ? now - s.lastPulseAt : null;
  const pageMeta = PAGES.find((p) => p.id === page) ?? PAGES[0];

  return (
    <main className="cockpit">
      <header className="strip" data-guide="annunciators">
        <button
          type="button"
          className={`annun ${warnLit ? "lit warning" : ""}`}
          aria-label={
            warnLit
              ? `Master warning: ${e?.warnings.length} active. Press to acknowledge.`
              : "Master warning: dark"
          }
          onClick={() => warnLit && setAckWarn(warnKey)}
        >
          MASTER
          <br />
          WARN
        </button>
        <div className="strip-title" data-guide="strip">
          <span className="brand">
            CORTEX-54<small>OPERATOR TERMINAL</small>
          </span>
          <span className="readouts" aria-live="off">
            <span>
              UTC <b>{utc(now)}</b>
            </span>
            <span>
              PULSE{" "}
              <b
                className={
                  pulseAge === null || pulseAge > 480_000 ? "red" : pulseAge > 360_000 ? "amber" : ""
                }
              >
                {s ? ago(s.lastPulseAt, now) : "—"}
              </b>
            </span>
            <span>
              JOURNAL <b>{s ? `#${s.journalHead.seq}` : "—"}</b>
            </span>
            <span>
              DATA{" "}
              <b className={st.error ? "amber" : ""}>
                {st.error ? "FAULT" : st.updatedAt ? `${ago(st.updatedAt, now)}` : "—"}
              </b>
            </span>
          </span>
        </div>
        <button
          type="button"
          className={`annun ${cautLit ? "lit caution" : ""}`}
          aria-label={
            cautLit
              ? `Master caution: ${e?.cautions.length} active. Press to acknowledge.`
              : "Master caution: dark"
          }
          onClick={() => cautLit && setAckCaut(cautKey)}
        >
          MASTER
          <br />
          CAUT
        </button>
      </header>

      <section className="display" aria-label="Engine and warning display">
        <div className="glass ewd">
          <div className="ewd-acct">
            {s ? (
              s.accounts.map((a) => <AccountColumn key={a.account} a={a} s={s} />)
            ) : (
              <div className="acct">
                <div className="skeleton" style={{ width: 120 }} />
                <div className="skeleton" style={{ width: 200, height: 40 }} />
              </div>
            )}
          </div>
          <div className="memo" aria-live="polite" data-guide="memo">
            {st.error && (
              <div className="alert caution">
                <span className="alert-title">TERMINAL DATA FAULT</span>
                <span className="alert-detail">{st.error}</span>
                <span className="alert-action">RETRYING EVERY 15 S</span>
              </div>
            )}
            {e?.warnings.map((w) => (
              <div key={w.id} className="alert warning">
                <span className="alert-title">{w.title}</span>
                <span className="alert-detail">{w.detail}</span>
                {w.actions.map((x) => (
                  <span key={x} className="alert-action">
                    {x}
                  </span>
                ))}
              </div>
            ))}
            {e?.cautions.map((c) => (
              <div key={c.id} className="alert caution">
                <span className="alert-title">{c.title}</span>
                <span className="alert-detail">{c.detail}</span>
                {c.actions.map((x) => (
                  <span key={x} className="alert-action">
                    {x}
                  </span>
                ))}
              </div>
            ))}
            {e && (
              <ul className="memo-list" aria-label="Memo">
                {e.memos.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            {e && e.warnings.length === 0 && e.cautions.length === 0 && (
              <span className="normal">NOTHING LIT · LEAVE IT ALONE</span>
            )}
          </div>
        </div>
      </section>

      <section className="display" aria-label="System display" data-guide="sd">
        <div className="glass sd">
          <h2 className="sd-title">{pageMeta.title}</h2>
          {!s ? (
            <div className="bars">
              <div className="skeleton" style={{ width: "60%" }} />
              <div className="skeleton" style={{ width: "45%" }} />
            </div>
          ) : page === "ACCT" ? (
            <>
              <Today s={s} e={e} now={now} goFeed={() => setPage("FEED")} />
              <AcctPage s={s} now={now} />
            </>
          ) : page === "FUNNEL" ? (
            <FunnelPage />
          ) : page === "MEM" ? (
            <MemPage />
          ) : page === "OPT" ? (
            <OptPage />
          ) : page === "GOV" ? (
            <GovPage now={now} />
          ) : page === "FCST" ? (
            <FcstPage now={now} />
          ) : page === "FEED" ? (
            <FeedPage now={now} />
          ) : page === "ASK" ? (
            <AskPage goFeed={() => setPage("FEED")} />
          ) : page === "SET" ? (
            <SettingsPage s={settings.data} reload={settings.reload} restartOnboarding={() => setOnb(true)} />
          ) : (
            <StsPage s={s} now={now} />
          )}
        </div>
      </section>

      <nav className="ecp" aria-label="System pages" data-guide="ecp">
        {PAGES.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className="key"
            aria-pressed={page === p.id}
            onClick={() => setPage(p.id)}
          >
            <span>
              {p.id}
              <span className="hot">{(i + 1) % 10}</span>
            </span>
            <span className="lamp" />
          </button>
        ))}
        <span className="spacer" />
        <span className="note">Keys 1–9, 0 · ? for the guide</span>
        <button type="button" className="key guide-key" onClick={() => setGuide(true)} aria-haspopup="dialog">
          <span>GUIDE</span>
          <span className="lamp" />
        </button>
      </nav>

      {s && (
        <section className="overhead" aria-label="Overhead panel" data-guide="overhead">
          {s.accounts.map((a) => (
            <AccountPanel key={a.account} a={a} run={run} busy={busy} />
          ))}
          <CourtPanel run={run} busy={busy} />
        </section>
      )}

      {onb && settings.data && (
        <Onboarding s={settings.data} reload={settings.reload} close={() => setOnb(false)} />
      )}

      <Guide open={guide} onClose={() => setGuide(false)} setPage={setPage} />

      {toast && (
        <div className={`toast ${toast.err ? "err" : ""}`} role="status">
          {toast.msg}
        </div>
      )}
    </main>
  );
}
