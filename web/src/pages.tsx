import type { CourtRow, MemoryView, OptionsRow, RejectionRow, StatusView } from "./api.ts";
import { useResource } from "./api.ts";
import { ago, Bar, parse, pct, usd, when } from "./instruments.tsx";

function Loading() {
  return (
    <div className="bars" aria-busy="true">
      <div className="skeleton" style={{ width: "62%" }} />
      <div className="skeleton" style={{ width: "48%" }} />
      <div className="skeleton" style={{ width: "55%" }} />
    </div>
  );
}

function Failed(props: { error: string }) {
  return <p className="empty amber">DATA FAULT · {props.error}</p>;
}

// ------------------------------------------------------------------ ACCT

export function AcctPage({ s, now }: { s: StatusView; now: number }) {
  return (
    <>
      <div className="sd-grid">
        {s.accounts.map((a) => (
          <section className="sd-block" key={a.account}>
            <h4>
              {a.account} positions <span className="dimtext">· {a.positions.length}</span>
            </h4>
            {!a.configured ? (
              <p className="empty">
                No live account connected. When one is, it stays dormant until you ratify it.
              </p>
            ) : a.positions.length === 0 ? (
              <p className="empty">Flat. Nothing at risk on this account.</p>
            ) : (
              <div className="scroll-x">
                <table className="ecam stack">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th className="num">Qty</th>
                      <th className="num">Entry</th>
                      <th className="num">Stop</th>
                      <th className="num">Target</th>
                      <th className="num">Risk</th>
                      <th>Stop type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.positions.map((p) => {
                      const risk = Number(p.qty) * (Number(p.avgEntry) - Number(p.stop));
                      return (
                        <tr key={p.symbol}>
                          <td className="w" data-label="SYMBOL">
                            {p.symbol}
                          </td>
                          <td className="num" data-label="QTY">
                            {p.qty}
                          </td>
                          <td className="num" data-label="ENTRY">
                            {p.avgEntry}
                          </td>
                          <td className="num a" data-label="STOP">
                            {p.stop}
                          </td>
                          <td className="num m" data-label="TARGET">
                            {p.target}
                          </td>
                          <td className="num" data-label="RISK">
                            {Number.isFinite(risk) ? usd(risk) : "—"}
                          </td>
                          <td className="w" data-label="STOP TYPE">
                            {p.brokerStop ? "BROKER" : "SYNTHETIC"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {(a.openOrders ?? []).length > 0 && (
              <>
                <h4 style={{ marginTop: 16 }}>Working orders</h4>
                <table className="ecam">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Role</th>
                      <th>Side</th>
                      <th className="num">Qty</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(a.openOrders ?? []).map((o) => (
                      <tr key={o.coid ?? `${o.symbol}-${o.role}-${o.qty}`}>
                        <td className="w">{o.symbol}</td>
                        <td className="w">{o.role}</td>
                        <td>{(o.side ?? "").toUpperCase()}</td>
                        <td className="num">{o.qty}</td>
                        <td>{(o.state ?? "").toUpperCase()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        ))}
      </div>
      <div className="sd-foot">
        {s.accounts.map((a) => (
          <span key={a.account}>
            {a.account} ORDERS TODAY <b>{a.ordersToday}</b> · RECONCILED <b>{ago(a.reconciledAt, now)}</b>
          </span>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ FUNNEL

const STAGE_TONE: Record<string, string> = {
  SCAR: "r",
  VALIDATOR: "a",
  BEAR: "a",
  TIER2: "w",
  TIER1: "",
  TIER0: "",
};

function Prob(props: { label: string; value: number | undefined; tone: string }) {
  const v = typeof props.value === "number" ? props.value : null;
  return (
    <div className="prob">
      <span>{props.label}</span>
      <span className="prob-track">
        <span
          className="prob-fill"
          style={{ width: `${(v ?? 0) * 100}%`, background: `var(--${props.tone})` }}
        />
      </span>
      <span className={props.tone}>{v === null ? "—" : v.toFixed(2)}</span>
    </div>
  );
}

export function FunnelPage() {
  const court = useResource<CourtRow[]>("/api/court", 60_000);
  const rej = useResource<RejectionRow[]>("/api/rejections", 60_000);
  return (
    <div className="sd-grid">
      <section className="sd-block">
        <h4>Court sessions</h4>
        {court.loading && !court.data ? (
          <Loading />
        ) : court.error ? (
          <Failed error={court.error} />
        ) : (court.data ?? []).length === 0 ? (
          <p className="empty">
            No sessions yet. A catalyst reaches the court only after Clef-flash and Clef 27B both promote it,
            at most 12 a day. <b>/court SYMBOL</b> convenes one by hand (that counts as an intervention).
          </p>
        ) : (
          (court.data ?? []).map((c) => {
            const p = parse<{ symbol?: string; win_raw?: number; win_cal?: number; bear?: number }>(
              c.payload_json,
              {},
            );
            const models = parse<{ role: string; provider: string; model: string }[]>(c.models_used, []);
            return (
              <article className="court" key={`${c.ts}-${p.symbol}`}>
                <div className="court-head">
                  <span className="white">{p.symbol ?? c.symbol}</span>
                  <span className="dimtext">{when(c.ts)}</span>
                  {c.proposed_conviction !== null && (
                    <span className="cyan">CONVICTION {c.proposed_conviction}/10</span>
                  )}
                </div>
                <Prob label="WIN RAW" value={p.win_raw} tone="white" />
                <Prob label="WIN CAL" value={p.win_cal} tone="green" />
                <Prob label="BEAR" value={p.bear} tone="amber" />
                {c.thesis_summary && (
                  <p className="prose">
                    <span className="green">BULL </span>
                    {c.thesis_summary}
                  </p>
                )}
                {c.bear_case_brief && (
                  <p className="prose">
                    <span className="amber">BEAR </span>
                    {c.bear_case_brief}
                  </p>
                )}
                {models.length > 0 && (
                  <p className="sub">{models.map((m) => `${m.role} ${m.model}`).join(" · ")}</p>
                )}
              </article>
            );
          })
        )}
      </section>
      <section className="sd-block">
        <h4>Rejections</h4>
        {rej.loading && !rej.data ? (
          <Loading />
        ) : rej.error ? (
          <Failed error={rej.error} />
        ) : (rej.data ?? []).length === 0 ? (
          <p className="empty">
            Nothing rejected yet. Every refusal (Clef, bear, scar tissue, validator) lands here and is graded
            later at 24 h, 72 h and 7 d.
          </p>
        ) : (
          <div className="scroll-x">
            <table className="ecam">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Stage</th>
                  <th>Symbol</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {(rej.data ?? []).map((r) => (
                  <tr key={`${r.ts}-${r.stage}-${r.symbol}-${r.reason_codes.length}`}>
                    <td className="w">{when(r.ts)}</td>
                    <td className={STAGE_TONE[r.stage] ?? ""}>{r.stage}</td>
                    <td className="w">{r.symbol}</td>
                    <td className="w">{parse<string[]>(r.reason_codes, []).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ MEM

export function MemPage() {
  const m = useResource<MemoryView>("/api/memory", 120_000);
  if (m.loading && !m.data) return <Loading />;
  if (m.error || !m.data) return <Failed error={m.error ?? "no data"} />;
  const rep = Object.entries(m.data.reputation).sort((a, b) => b[1].signals - a[1].signals);
  return (
    <div className="sd-grid">
      <section className="sd-block">
        <h4>Scar tissue · hard rules</h4>
        {m.data.scars.length === 0 ? (
          <p className="empty">
            No merged rules. The Governor proposes one by pull request after three or more losing trades share
            a pattern; you merge it.
          </p>
        ) : (
          <table className="ecam">
            <tbody>
              {m.data.scars.map((r) => (
                <tr key={r.id}>
                  <td className={r.kind === "hard_filter" ? "r" : "c"}>{r.id}</td>
                  <td className="w">{r.rule}</td>
                  <td className="num">{r.expires ? `UNTIL ${r.expires}` : "STANDING"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="sd-block">
        <h4>Source reputation · W rep</h4>
        {rep.length === 0 ? (
          <p className="empty">
            No scored sources yet. Weights stay at 1.00 until a source has 20 graded outcomes.
          </p>
        ) : (
          <div className="bars">
            {rep.map(([k, v]) => (
              <Bar
                key={k}
                label={`${k.slice(0, 22)} · ${v.signals}`}
                value={v.weight}
                max={1.2}
                amber={0.85}
                fmt={(x) => x.toFixed(2)}
              />
            ))}
          </div>
        )}
      </section>
      <section className="sd-block">
        <h4>Beliefs · decaying</h4>
        {m.data.beliefs.length === 0 ? (
          <p className="empty">
            None yet. A belief forms after three closed trades on a symbol or strategy and fades with a 60-day
            half-life.
          </p>
        ) : (
          <table className="ecam">
            <tbody>
              {m.data.beliefs.map((b) => (
                <tr key={b.statement}>
                  <td className="w">{b.statement}</td>
                  <td className={`num ${b.confidence >= 0.35 ? "" : "a"}`}>{b.confidence.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ OPT

export function OptPage() {
  const o = useResource<OptionsRow[]>("/api/options", 120_000);
  if (o.loading && !o.data) return <Loading />;
  if (o.error || !o.data) return <Failed error={o.error ?? "no data"} />;
  const closes = o.data.filter((r) => r.kind === "CLOSE");
  const open = o.data.filter((r) => r.kind === "OPEN" && !closes.some((c) => c.trade_id === r.trade_id));
  const er = closes.length ? closes.reduce((s, c) => s + (c.r ?? 0), 0) / closes.length : null;
  return (
    <>
      {o.data.length === 0 ? (
        <p className="empty">
          The shadow lab hasn't opened anything yet. It runs at 14:50 and 19:40 UTC on weekdays and only opens
          structures during market hours. Every trade here is virtual: nothing is sent to a broker.
        </p>
      ) : (
        <div className="scroll-x">
          <table className="ecam">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Strategy</th>
                <th>Underlying</th>
                <th className="num">Max loss</th>
                <th className="num">P&amp;L</th>
                <th className="num">R</th>
              </tr>
            </thead>
            <tbody>
              {o.data.map((r) => (
                <tr key={`${r.trade_id}-${r.kind}`}>
                  <td className="w">{when(r.ts)}</td>
                  <td className={r.kind === "OPEN" ? "c" : r.reason === "STOP" ? "a" : ""}>
                    {r.kind === "OPEN" ? "OPEN" : `CLOSE ${r.reason ?? ""}`}
                  </td>
                  <td className="w">{r.strategy.replace("OPTIONS_", "").replace(/_V\d+$/, "")}</td>
                  <td className="w">{r.underlying}</td>
                  <td className="num">{usd(r.max_loss_cents / 100, 0)}</td>
                  <td className={`num ${(r.pnl_cents ?? 0) < 0 ? "a" : ""}`}>
                    {r.pnl_cents === null ? "—" : usd(r.pnl_cents / 100)}
                  </td>
                  <td className="num">{r.r === null ? "—" : r.r.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sd-foot">
        <span>
          OPEN <b>{open.length}</b>
        </span>
        <span>
          SCORED <b>{closes.length}</b> / 30
        </span>
        <span>
          E[R] <b>{er === null ? "—" : er.toFixed(2)}</b>
        </span>
        <span>VIRTUAL LEDGER · PESSIMISTIC FILLS</span>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ GOV

export function GovPage({ now }: { now: number }) {
  const m = useResource<MemoryView>("/api/memory", 300_000);
  if (m.loading && !m.data) return <Loading />;
  if (m.error || !m.data) return <Failed error={m.error ?? "no data"} />;
  const card = m.data.report
    ? parse<{ card?: { title: string; sections: { name: string; value: string }[] } }>(
        m.data.report.payload_json,
        {},
      ).card
    : undefined;
  if (!card)
    return (
      <p className="empty">
        No Governor report yet. It runs daily at 06:23 UTC and posts the full card on Sundays.
      </p>
    );
  const gate = card.sections.find((x) => x.name === "LIVE gate");
  const rest = card.sections.filter((x) => x !== gate);
  return (
    <div className="sd-grid">
      <section className="sd-block">
        <h4>
          {card.title.replace(/^\S+\s/, "")}{" "}
          <span className="dimtext">· {ago(m.data.report?.produced_at ?? null, now)} ago</span>
        </h4>
        {rest.map((x) => (
          <div key={x.name} style={{ marginBottom: 12 }}>
            <p className="label dim" style={{ margin: "0 0 2px" }}>
              {x.name}
            </p>
            <p className="prose">{x.value}</p>
          </div>
        ))}
      </section>
      {gate && (
        <section className="sd-block">
          <h4>Real-money gate</h4>
          <ul className="gate">
            {gate.value.split("\n").map((line) => {
              const tone = line.startsWith("✅")
                ? "green"
                : line.startsWith("❌")
                  ? "amber"
                  : line.startsWith("⏳")
                    ? "cyan"
                    : "white";
              const word =
                tone === "green" ? "PASS" : tone === "amber" ? "OPEN" : tone === "cyan" ? "WAIT" : "NOTE";
              return (
                <li key={line} className={tone}>
                  <span style={{ display: "inline-block", width: 52 }}>{word}</span>
                  <span className="white">{line.replace(/^\S+\s/, "")}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ STS

export function StsPage({ s, now }: { s: StatusView; now: number }) {
  const fr = Object.entries(s.budget.fractions).sort((a, b) => b[1] - a[1]);
  return (
    <div className="sd-grid">
      <section className="sd-block">
        <h4>Regime</h4>
        <table className="ecam">
          <thead>
            <tr>
              <th>Arena</th>
              <th>Posture</th>
              <th className="num">Score</th>
              <th className="num">Age</th>
            </tr>
          </thead>
          <tbody>
            {s.regimes.map((r) => (
              <tr key={r.arena}>
                <td className="w">{r.arena}</td>
                <td
                  className={
                    r.posture === "NEW_ENTRY_ALLOWED" || r.posture === "RISK_ON"
                      ? ""
                      : r.posture === "INFO"
                        ? "w"
                        : "a"
                  }
                >
                  {r.posture}
                </td>
                <td className="num">{r.score === null ? "—" : r.score.toFixed(0)}</td>
                <td className={`num ${r.fresh ? "" : "a"}`}>
                  {r.ageMinutes < 120 ? `${r.ageMinutes} min` : `${Math.round(r.ageMinutes / 60)} h`}
                  {r.fresh ? "" : " STALE"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="sd-block">
        <h4>
          {(s.budget.scope ?? "cloudflare") === "cloudflare" ? "Free-tier budget" : "Cloudflare AI allowance"}{" "}
          · <span className={s.budget.mode === "NORMAL" ? "green" : "amber"}>{s.budget.mode}</span>
        </h4>
        <div className="bars">
          {s.budget.scope === "none" ? (
            <p className="empty">
              Nothing to meter on your computer: no Cloudflare quotas here. AI model limits and spend caps are
              in SETTINGS → AI models.
            </p>
          ) : s.budget.scope === "workers_ai" ? (
            Object.keys(s.budget.neurons ?? {}).length === 0 ? (
              <p className="empty">
                No Cloudflare AI used yet today (free daily allowance on your own account).
              </p>
            ) : (
              Object.entries(s.budget.neurons ?? {}).map(([k, v]) => (
                <Bar
                  key={k}
                  label={k.replace(/^neurons_/, "").replace(/_/g, " ")}
                  value={v}
                  amber={0.7}
                  red={0.9}
                  fmt={(x) => pct(x, 0)}
                />
              ))
            )
          ) : fr.length === 0 ? (
            <p className="empty">Nothing metered yet today.</p>
          ) : (
            fr.map(([k, v]) => (
              <Bar
                key={k}
                label={k.replace(/_/g, " ")}
                value={v}
                amber={0.7}
                red={0.9}
                fmt={(x) => pct(x, 0)}
              />
            ))
          )}
        </div>
      </section>
      <section className="sd-block">
        <h4>Journal</h4>
        <table className="ecam">
          <tbody>
            <tr>
              <td className="w">Head</td>
              <td>#{s.journalHead.seq}</td>
            </tr>
            <tr>
              <td className="w">Hash</td>
              <td>{s.journalHead.sha.slice(0, 16)}…</td>
            </tr>
            <tr>
              <td className="w">Unflushed rows</td>
              <td className={s.outboxPending > 50 ? "a" : ""}>{s.outboxPending}</td>
            </tr>
            <tr>
              <td className="w">Last pulse</td>
              <td>{ago(s.lastPulseAt, now)} ago</td>
            </tr>
          </tbody>
        </table>
        <p className="sub" style={{ marginTop: 8 }}>
          The Governor re-verifies the whole chain daily; a break lights MASTER WARN in Discord #alarms.
        </p>
      </section>
    </div>
  );
}
