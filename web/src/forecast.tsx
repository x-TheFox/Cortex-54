import { useState } from "react";
import { type ForecastView, useResource } from "./api.ts";
import { ago } from "./instruments.tsx";

/**
 * FCST page (ADR-047): "what the market might look like" according to Kronos, beside "what the robot thinks".
 * The robot does not forecast prices, so its side is its real plan — entry, stop, target and the probability it
 * acted on — drawn on the same axis. Kronos is amber and labelled low confidence on purpose.
 */

const fmt = (x: number) => (x >= 1000 ? x.toFixed(0) : x >= 10 ? x.toFixed(2) : x.toPrecision(4));
const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

function robotLines(f: ForecastView, now: number): string[] {
  const r = f.robot;
  const out: string[] = [];
  if (r.position) {
    const p = r.position;
    out.push(
      `Holding ${f.symbol} on ${p.account} since ${ago(p.opened_at, now)} ago, bought at ${fmt(p.entry)}.`,
      `It sells at ${fmt(p.target)} to take profit, or at ${fmt(p.stop)} to cap the loss — whichever comes first — and closes it within ${Math.max(0, Math.round((p.max_hold_until - now) / 3_600_000))} h regardless.`,
    );
  } else if (r.plan && now - r.plan.created_at < 3 * 86_400_000) {
    const p = r.plan;
    out.push(
      `Latest plan ${ago(p.created_at, now)} ago (${p.strategy}): buy around ${fmt(p.entry_low)}–${fmt(p.entry_high)}, stop ${fmt(p.stop)}, target ${fmt(p.target)}.`,
      `It rated the chance of reaching the target before the stop at ${Math.round(p.win_prob * 100)}% (after calibration)${p.bear_lethality > 0 ? `, and the bear's case at ${Math.round(p.bear_lethality * 100)}%` : ""}.`,
    );
  } else {
    out.push(
      `No position and no recent plan for ${f.symbol}: none of its strategies sees a setup worth the fees right now.`,
    );
  }
  if (r.regime)
    out.push(
      `Market mood for this arena: ${r.regime.posture.replace(/_/g, " ").toLowerCase()}${r.regime.score !== null ? ` (score ${Math.round(r.regime.score)})` : ""}.`,
    );
  return out;
}

function Chart({ f }: { f: ForecastView }) {
  const k = f.kronos;
  const hist = k?.hist ?? [];
  const fan = k?.fan;
  if (!k || hist.length < 2)
    return (
      <p className="empty">
        No Kronos forecast for {f.symbol} yet. It runs every 4 hours (stocks: daily candles).
      </p>
    );
  const steps = fan?.p50.length ?? 0;
  const W = 560; // ~3.7:1, the display's usual shape, so the drawing fills the glass
  const H = 150;
  const n = hist.length + steps;
  const xOf = (i: number) => (i / Math.max(1, n - 1)) * W;
  const plan = f.robot.position
    ? { entry: f.robot.position.entry, stop: f.robot.position.stop, target: f.robot.position.target }
    : f.robot.plan && f.now - f.robot.plan.created_at < 3 * 86_400_000
      ? {
          entry: (f.robot.plan.entry_low + f.robot.plan.entry_high) / 2,
          stop: f.robot.plan.stop,
          target: f.robot.plan.target,
        }
      : null;
  const ys = [...hist, ...(fan ? [...fan.p10, ...fan.p90] : []), ...(plan ? [plan.stop, plan.target] : [])];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pad = (hi - lo) * 0.06 || 1;
  const yOf = (v: number) => H - 6 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 12);
  const line = (vals: number[], start: number) =>
    vals.map((v, i) => `${i ? "L" : "M"}${xOf(start + i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(" ");
  const nowX = xOf(hist.length - 1);
  const last = hist[hist.length - 1] as number;
  const band =
    fan &&
    `M${nowX.toFixed(1)} ${yOf(last).toFixed(1)} ` +
      fan.p90.map((v, i) => `L${xOf(hist.length + i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(" ") +
      " " +
      [...fan.p10]
        .reverse()
        .map((v, i) => `L${xOf(hist.length + steps - 1 - i).toFixed(1)} ${yOf(v).toFixed(1)}`)
        .join(" ") +
      " Z";
  const level = (v: number, cls: string, label: string) => (
    <g className={cls}>
      <line x1={nowX} x2={W} y1={yOf(v)} y2={yOf(v)} vectorEffect="non-scaling-stroke" />
      <text x={W - 2} y={yOf(v) - 3} textAnchor="end">
        {label} {fmt(v)}
      </text>
    </g>
  );
  return (
    <figure className="fcst-fig">
      <svg
        className="fcst"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${f.symbol}: last ${hist.length} ${k.candle_hours}-hour closes, Kronos 10 to 90 percent band for ${k.horizon_label ?? `${k.horizon_hours} hours`}${plan ? ", and the robot's entry, stop and target" : ""}`}
      >
        <line className="fcst-now" x1={nowX} x2={nowX} y1="0" y2={H} vectorEffect="non-scaling-stroke" />
        <path className="fcst-hist" d={line(hist, 0)} vectorEffect="non-scaling-stroke" />
        {band && <path className="fcst-band" d={band} />}
        {fan && (
          <path
            className="fcst-mid"
            d={`M${nowX} ${yOf(last)} ${line(fan.p50, hist.length).replace(/^M/, "L")}`}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {plan && level(plan.target, "fcst-target", "TARGET")}
        {plan && level(plan.entry, "fcst-entry", "ENTRY")}
        {plan && level(plan.stop, "fcst-stop", "STOP")}
      </svg>
      <figcaption className="sub">
        <span>PRICE · LAST {Math.round((hist.length * k.candle_hours) / 24)} D</span>
        {" · "}
        <span className="amber">▒ KRONOS 10–90% · ┄ MIDDLE PATH · LOW CONFIDENCE</span>
        {plan && (
          <>
            {" · "}
            <span className="cyan">━ ROBOT PLAN</span>
          </>
        )}
        <span className="dimtext"> · NOW ┊</span>
        {plan && (
          <span className="fcst-levels">
            <span className="green">TARGET {fmt(plan.target)}</span>
            <span className="cyan">ENTRY {fmt(plan.entry)}</span>
            <span className="red">STOP {fmt(plan.stop)}</span>
          </span>
        )}
      </figcaption>
    </figure>
  );
}

export function FcstPage({ now }: { now: number }) {
  const [sym, setSym] = useState("BTC/USD");
  const r = useResource<ForecastView>(`/api/forecast?symbol=${encodeURIComponent(sym)}`, 120_000);
  const f = r.data;
  const symbols = f?.symbols.length ? f.symbols : ["BTC/USD"];
  return (
    <div className="fcst-page">
      {[
        { label: "Crypto · 4 h candles", list: symbols.filter((s) => s.includes("/")) },
        { label: "Stocks · daily candles", list: symbols.filter((s) => !s.includes("/")) },
      ]
        .filter((g) => g.list.length > 0)
        .map((g) => (
          <fieldset key={g.label} className="fcst-picker">
            <legend className="fcst-legend">{g.label}</legend>
            {g.list.map((s) => (
              <button
                key={s}
                type="button"
                className="chip"
                aria-pressed={s === sym}
                onClick={() => setSym(s)}
              >
                {s.replace("/USD", "")}
              </button>
            ))}
          </fieldset>
        ))}
      {r.error && !f ? (
        <p className="empty amber">DATA FAULT · {r.error}</p>
      ) : !f ? (
        <div className="bars" aria-busy="true">
          <div className="skeleton" style={{ width: "70%", height: 120 }} />
        </div>
      ) : (
        <>
          <Chart f={f} />
          <div className="sd-grid">
            <section className="sd-block">
              <h4>
                <span className="amber">What Kronos thinks</span>{" "}
                <span className="dimtext">
                  · low confidence
                  {f.kronos
                    ? ` · ${ago(f.kronos.produced_at, now)} ago${f.kronos.stale ? " · STALE" : ""}`
                    : ""}
                </span>
              </h4>
              {f.kronos ? (
                <>
                  <p className="prose">
                    {f.kronos.p_up >= 0.6
                      ? "Leans up"
                      : f.kronos.p_up <= 0.4
                        ? "Leans down"
                        : "No clear lean"}
                    : {Math.round(f.kronos.p_up * 100)}% of its sampled futures end higher after{" "}
                    {f.kronos.horizon_label ?? `${f.kronos.horizon_hours} h`}; the average path moves{" "}
                    {signed(f.kronos.exp_ret)}.
                  </p>
                  <p className="prose dimtext">{f.kronos.about}</p>
                </>
              ) : (
                <p className="empty">No forecast yet.</p>
              )}
            </section>
            <section className="sd-block">
              <h4>
                <span className="cyan">What the robot thinks</span>{" "}
                <span className="dimtext">· its real plan, not a price forecast</span>
              </h4>
              {robotLines(f, now).map((l) => (
                <p className="prose" key={l}>
                  {l}
                </p>
              ))}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
