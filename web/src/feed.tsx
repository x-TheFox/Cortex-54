import { type ReactNode, useEffect, useState } from "react";
import { api, type Embed, type FeedItem, useResource } from "./api.ts";
import { ago } from "./instruments.tsx";

/**
 * FEED (ADR-071): everything the brain says, as it says it: trades, court sessions, news that cleared triage,
 * alarms, reports. The same cards Discord gets, kept by the brain itself, so Discord is optional.
 */
export const CHANNELS: { id: string; label: string }[] = [
  { id: "", label: "ALL" },
  { id: "executions", label: "TRADES" },
  { id: "court", label: "COURT" },
  { id: "alarms", label: "ALARMS" },
  { id: "world_intel", label: "NEWS" },
  { id: "briefs", label: "BRIEFS" },
  { id: "governor", label: "REPORTS" },
  { id: "terminal", label: "AGENT LOG" },
];
const LABEL = Object.fromEntries(CHANNELS.map((c) => [c.id, c.label]));

/** Discord-flavoured markdown → React (bold, inline code, links); never innerHTML. */
export function Md({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  let i = 0;
  while (m) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<b key={i++}>{m[1]}</b>);
    else if (m[2]) out.push(<code key={i++}>{m[2]}</code>);
    else if (m[3] && m[4])
      out.push(
        <a key={i++} href={m[4]} target="_blank" rel="noreferrer noopener">
          {m[3]}
        </a>,
      );
    else if (m[5])
      out.push(
        <a key={i++} href={m[5]} target="_blank" rel="noreferrer noopener">
          {m[5].replace(/^https?:\/\//, "").slice(0, 48)}
        </a>,
      );
    last = re.lastIndex;
    m = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const hex = (c: number | undefined) =>
  c === undefined ? "var(--bezel-hi)" : `#${c.toString(16).padStart(6, "0")}`;

function Card({ e }: { e: Embed }) {
  return (
    <div className="card" style={{ borderLeftColor: hex(e.color) }}>
      {e.title && (
        <div className="card-title">
          <Md text={e.title} />
        </div>
      )}
      {e.description && (
        <div className="card-desc">
          <Md text={e.description} />
        </div>
      )}
      {e.fields && e.fields.length > 0 && (
        <dl className="card-fields">
          {e.fields.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a card's fields never reorder; names can repeat
            <div key={`${f.name}${i}`} className={f.inline ? "inline" : ""}>
              <dt>
                <Md text={f.name} />
              </dt>
              <dd>
                <Md text={f.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {e.image?.url && /^https:\/\//.test(e.image.url) && (
        <img className="card-img" src={e.image.url} alt={e.title ?? "chart"} loading="lazy" />
      )}
      {e.footer?.text && <div className="card-foot">{e.footer.text}</div>}
    </div>
  );
}

export function FeedPage({ now }: { now: number }) {
  const [ch, setCh] = useState("");
  const [older, setOlder] = useState<FeedItem[]>([]);
  const [more, setMore] = useState(true);
  const first = useResource<FeedItem[]>(`/api/feed?limit=40${ch ? `&channel=${ch}` : ""}`, 20_000);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new channel filter starts the paging over
  useEffect(() => {
    setOlder([]);
    setMore(true);
  }, [ch]);
  const items = [
    ...(first.data ?? []),
    ...older.filter((o) => !(first.data ?? []).some((f) => f.id === o.id)),
  ];
  const loadOlder = async () => {
    const before = items.at(-1)?.id;
    if (!before) return;
    const next = await api<FeedItem[]>(`/api/feed?limit=40&before=${before}${ch ? `&channel=${ch}` : ""}`);
    setOlder((o) => [...o, ...next]);
    if (next.length < 40) setMore(false);
  };
  return (
    <div className="feed">
      <fieldset className="fcst-picker">
        <legend className="fcst-legend">Show</legend>
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            type="button"
            className="chip"
            aria-pressed={ch === c.id}
            onClick={() => setCh(c.id)}
          >
            {c.label}
          </button>
        ))}
      </fieldset>
      {first.error && <p className="empty amber">DATA FAULT · {first.error}</p>}
      {first.loading && !first.data ? (
        <div className="bars" aria-busy="true">
          <div className="skeleton" style={{ width: "60%" }} />
          <div className="skeleton" style={{ width: "40%" }} />
        </div>
      ) : items.length === 0 ? (
        <p className="empty">
          Nothing here yet. Trades, court sessions, news the robot found worth a look, alarms and reports all
          appear here as they happen.
        </p>
      ) : (
        <ol className="feed-list">
          {items.map((it) => (
            <li key={it.id} className="feed-item">
              <div className="feed-meta">
                <span className="feed-ch">{LABEL[it.channel] ?? it.channel.toUpperCase()}</span>
                <time dateTime={new Date(it.ts).toISOString()} title={new Date(it.ts).toLocaleString()}>
                  {ago(it.ts, now)}
                </time>
              </div>
              {it.msg.content && (
                <div className="feed-text">
                  <Md text={it.msg.content} />
                </div>
              )}
              {(it.msg.embeds ?? []).map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a message's embeds never reorder
                <Card key={`${it.id}-${i}`} e={e} />
              ))}
            </li>
          ))}
        </ol>
      )}
      {items.length >= 40 && more && (
        <button type="button" className="chip" onClick={() => void loadOlder()}>
          OLDER
        </button>
      )}
    </div>
  );
}
