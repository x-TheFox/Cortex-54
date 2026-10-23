import type { AccountView } from "./api.ts";

export const usd = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined ? "—" : `$${x.toFixed(d)}`;
export const pct = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined ? "—" : `${(x * 100).toFixed(d)}%`;
export const ago = (ms: number | null, now: number) => {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
};
export const utc = (ms: number) => new Date(ms).toISOString().slice(11, 19);
export const when = (ms: number) => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;
export function parse<T>(s: string | null | undefined, d: T): T {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
}

/** Open risk as a fraction of equity: Σ qty·(entry − stop) / equity. */
export function heat(a: AccountView): number {
  if (!a.equityUsd || a.equityUsd <= 0) return 0;
  let risk = 0;
  for (const p of a.positions) {
    const r = Number(p.qty) * (Number(p.avgEntry) - Number(p.stop));
    if (Number.isFinite(r) && r > 0) risk += r;
  }
  return risk / a.equityUsd;
}

const A0 = -200; // dial sweep, degrees (ECAM N1-style 220° arc)
const A1 = 20;
const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
};
const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

/**
 * A measuring dial in the ECAM manner: white scale, amber and red limit sectors, a needle and a boxed digital
 * readout whose colour follows the same limits. `value` and limits share one unit (fractions here).
 */
export function Dial(props: {
  label: string;
  value: number;
  max: number;
  amber: number;
  red: number;
  fmt: (v: number) => string;
}) {
  const { value, max, amber, red } = props;
  const k = (v: number) => A0 + (Math.min(Math.max(v, 0), max) / max) * (A1 - A0);
  const tone = value >= red ? "red" : value >= amber ? "amber" : "green";
  const [nx, ny] = polar(66, 64, 44, k(value));
  return (
    <div
      className="dial"
      role="img"
      aria-label={`${props.label} ${props.fmt(value)}${tone === "green" ? "" : `, ${tone === "red" ? "warning" : "caution"}`}`}
    >
      <svg viewBox="0 0 132 74" aria-hidden="true">
        <path d={arc(66, 64, 52, A0, A1)} fill="none" stroke="#e9eef1" strokeWidth="1.5" />
        <path d={arc(66, 64, 52, k(amber), k(red))} fill="none" stroke="var(--amber)" strokeWidth="4" />
        <path d={arc(66, 64, 52, k(red), A1)} fill="none" stroke="var(--red)" strokeWidth="4" />
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const [x0, y0] = polar(66, 64, 52, A0 + f * (A1 - A0));
          const [x1, y1] = polar(66, 64, 46, A0 + f * (A1 - A0));
          return <line key={f} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#e9eef1" strokeWidth="1.5" />;
        })}
        <line
          x1="66"
          y1="64"
          x2={nx}
          y2={ny}
          stroke={`var(--${tone})`}
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="66" cy="64" r="3" fill="#e9eef1" />
      </svg>
      <span className={`dial-value ${tone}`}>{props.fmt(value)}</span>
      <span className="dial-label">{props.label}</span>
    </div>
  );
}

/** Equity over time, drawn from the brain's hourly samples (no smoothing, no fill). */
export function Trend(props: { points: number[][] | undefined; hwm: number | null; label: string }) {
  const pts = (props.points ?? []).filter((p) => p.length === 2 && Number.isFinite(p[1]));
  if (pts.length < 2) {
    return <p className="sub">{props.label}: first hourly samples arrive after the next pulses.</p>;
  }
  const xs = pts.map((p) => p[0] as number);
  const ys = pts.map((p) => p[1] as number);
  const lo = Math.min(...ys, props.hwm ?? Number.POSITIVE_INFINITY);
  const hi = Math.max(...ys, props.hwm ?? Number.NEGATIVE_INFINITY);
  const span = hi - lo || 1;
  const x0 = xs[0] as number;
  const xspan = (xs[xs.length - 1] as number) - x0 || 1;
  const xOf = (t: number) => ((t - x0) / xspan) * 400;
  const yOf = (v: number) => 50 - ((v - lo) / span) * 44;
  const d = pts
    .map((p, i) => `${i ? "L" : "M"}${xOf(p[0] as number).toFixed(1)} ${yOf(p[1] as number).toFixed(1)}`)
    .join(" ");
  const hours = Math.round(xspan / 3_600_000);
  return (
    <figure className="trend-fig">
      <svg
        className="trend"
        viewBox="0 0 400 54"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${props.label} trend, ${pts.length} hourly samples`}
      >
        {props.hwm !== null && (
          <line
            x1="0"
            x2="400"
            y1={yOf(props.hwm)}
            y2={yOf(props.hwm)}
            stroke="var(--magenta)"
            strokeWidth="1"
            strokeDasharray="3 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path d={d} fill="none" stroke="var(--green)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="sub">
        EQUITY · LAST {hours >= 48 ? `${Math.round(hours / 24)} D` : `${hours} H`}, HOURLY
        {props.hwm !== null && (
          <>
            {" · "}
            <span className="magenta">- - HWM {usd(props.hwm)}</span>
          </>
        )}
      </figcaption>
    </figure>
  );
}

/** A labelled horizontal gauge with optional amber/red limit marks (fractions of max). */
export function Bar(props: {
  label: string;
  value: number;
  max?: number;
  amber?: number;
  red?: number;
  fmt?: (v: number) => string;
}) {
  const max = props.max ?? 1;
  const f = Math.min(1, Math.max(0, props.value / max));
  const tone =
    props.red !== undefined && props.value >= props.red
      ? "red"
      : props.amber !== undefined && props.value >= props.amber
        ? "amber"
        : "";
  return (
    <div className="bar">
      <span>{props.label}</span>
      <span className="bar-track">
        <span className={`bar-fill ${tone}`} style={{ width: `${f * 100}%` }} />
        {props.amber !== undefined && (
          <span className="bar-mark" style={{ left: `${(props.amber / max) * 100}%` }} />
        )}
        {props.red !== undefined && (
          <span className="bar-mark red" style={{ left: `${(props.red / max) * 100}%` }} />
        )}
      </span>
      <span className={tone || "green"}>{(props.fmt ?? pct)(props.value)}</span>
    </div>
  );
}
