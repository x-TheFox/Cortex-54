import { useMemo, useState } from "react";
import {
  type EndpointView,
  type ModelList,
  type PoolPrefs,
  type Preset,
  post,
  presetFor,
  type Result,
  type SettingsView,
  type Tier,
  useResource,
  waitForBrain,
} from "./api.ts";

/**
 * SETTINGS (ADR-071/072): everything the robot needs, in plain words, on one page. Each section saves on its own;
 * the local brain applies a save in a few seconds without a restart. Keys never come back to the browser: a saved key
 * shows only as "…last4".
 */

export type Save = (patch: Record<string, unknown>) => Promise<Result>;

export function useSaver(reload: () => void): { save: Save; saving: boolean } {
  const [saving, setSaving] = useState(false);
  const save: Save = async (patch) => {
    setSaving(true);
    try {
      const r = await post<Result>("/api/settings/save", patch);
      if (r.ok) await waitForBrain();
      reload();
      return r;
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
      setSaving(false);
    }
  };
  return { save, saving };
}

function Note({ r }: { r: Result | null }) {
  if (!r) return null;
  return (
    <p className={`note-line ${r.ok ? "green" : "amber"}`} role="status">
      {r.message}
    </p>
  );
}

function Secret(props: {
  label: string;
  hint?: string | undefined;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="set-field">
      <span className="label dim">{props.label}</span>
      <input
        className="field plain"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={
          props.hint ? `saved ${props.hint} · paste to replace` : (props.placeholder ?? "paste here")
        }
        value={props.value}
        onChange={(e) => props.onChange(e.target.value.trim())}
      />
    </label>
  );
}

const Ext = ({ href, children }: { href: string; children: string }) => (
  <a href={href} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
);

// ------------------------------------------------------------------ trading account

export function TradingSection({ s, save, saving }: { s: SettingsView; save: Save; saving: boolean }) {
  const [mode, setMode] = useState(s.mode ?? "demo");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [r, setR] = useState<Result | null>(null);
  const k = s.keys ?? {};
  const test = async () => setR(await post<Result>("/api/settings/test", { kind: "alpaca", keyId, secret }));
  return (
    <section className="set-sec">
      <h4>Trading account</h4>
      <div className="choice-row" role="radiogroup" aria-label="Mode">
        <button
          type="button"
          className="choice"
          aria-pressed={mode === "demo"}
          onClick={() => setMode("demo")}
        >
          <b>Demo</b>
          <span>No accounts. A simulated $54 on live crypto prices. Nothing to set up.</span>
        </button>
        <button
          type="button"
          className="choice"
          aria-pressed={mode === "paper"}
          onClick={() => setMode("paper")}
        >
          <b>Paper</b>
          <span>
            Your free Alpaca paper account: fake money, real market. Adds stocks, news and research.
          </span>
        </button>
      </div>
      {mode === "paper" && (
        <>
          <p className="cost">
            Create a free account at <Ext href="https://app.alpaca.markets/signup">alpaca.markets</Ext>, open
            the <b>Paper</b> dashboard, and press <b>Generate</b> under API keys. Use paper keys only.
          </p>
          <div className="set-grid">
            <Secret
              label="KEY ID"
              hint={k.ALPACA_PAPER_KEY_ID?.hint}
              value={keyId}
              onChange={setKeyId}
              placeholder="PK…"
            />
            <Secret label="SECRET" hint={k.ALPACA_PAPER_SECRET?.hint} value={secret} onChange={setSecret} />
          </div>
        </>
      )}
      <div className="set-actions">
        {mode === "paper" && (
          <button type="button" className="chip" onClick={() => void test()}>
            TEST CONNECTION
          </button>
        )}
        <button
          type="button"
          className="chip go"
          disabled={saving}
          onClick={async () =>
            setR(
              await save({
                mode,
                keys: {
                  ...(keyId ? { ALPACA_PAPER_KEY_ID: keyId } : {}),
                  ...(secret ? { ALPACA_PAPER_SECRET: secret } : {}),
                },
              }),
            )
          }
        >
          {saving ? "SAVING…" : "SAVE"}
        </button>
      </div>
      <Note r={r} />
    </section>
  );
}

// ------------------------------------------------------------------ AI models (the pool)

const prefsNote = (s: SettingsView) => {
  const p = s.llm?.prefs;
  if (!p) return "";
  const order = p.prefer === "free_first" ? "free first" : p.prefer === "paid_first" ? "paid first" : "mixed";
  return ` · ${order} · ${p.round_robin ? "round robin" : "fixed order"}`;
};

function PoolStatus({ s }: { s: SettingsView }) {
  const notes = s.pool?.notes ?? [];
  return (
    <div className="pool-status">
      {notes.map((n) => (
        <p
          key={n.text}
          className={`note-line ${n.level === "ok" ? "green" : n.level === "warn" ? "amber" : "red"}`}
        >
          {n.level === "block" ? "⛔ " : n.level === "warn" ? "⚠️ " : "✓ "}
          {n.text}
        </p>
      ))}
      {s.pool && s.pool.entries.length > 0 && (
        <details>
          <summary className="cost">
            {s.pool.entries.length} {s.pool.entries.length === 1 ? "model" : "models"} in rotation · tried in
            this order{prefsNote(s)}
          </summary>
          <ol className="pool-list">
            {s.pool.entries.map((e) => (
              <li key={`${e.provider}/${e.model}`}>
                <span className={`tier ${e.tier}`}>{e.tier.toUpperCase()}</span> {e.model}{" "}
                <span className="dimtext">
                  · {e.source} · {e.family}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** Paste anything: a key (recognized), or a URL. Then pick models. */
function AddSource({ s, save, done }: { s: SettingsView; save: Save; done: () => void }) {
  const presets = s.presets ?? [];
  const [input, setInput] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [fmt, setFmt] = useState<"openai" | "anthropic">("openai");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [tier, setTier] = useState<Tier>("paid");
  const [list, setList] = useState<ModelList | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [filter, setFilter] = useState("");
  const [r, setR] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const isUrl = /^https?:\/\//.test(input.trim());
  const key = isUrl ? "" : input.trim();

  const choose = (p: Preset | null, raw = input) => {
    setPreset(p);
    setList(null);
    setPicked([]);
    setR(null);
    if (p) {
      setFmt(p.format);
      setUrl(/^https?:\/\//.test(raw.trim()) ? raw.trim() : p.url);
      setName(p.name.replace(/ \(.*\)$/, ""));
      setTier(p.tier);
    } else if (/^https?:\/\//.test(raw.trim())) {
      setUrl(raw.trim());
      setName(new URL(raw.trim()).host);
      setTier(/127\.0\.0\.1|localhost/.test(raw) ? "local" : "paid");
    }
  };
  const onPaste = (v: string) => {
    setInput(v);
    const p = /^https?:\/\//.test(v.trim())
      ? (presets.find((x) => x.url && v.trim().startsWith(x.url.replace(/\/v1$/, ""))) ?? null)
      : presetFor(v, presets);
    choose(p, v);
  };
  const discover = async () => {
    setBusy(true);
    const l = await post<ModelList>("/api/settings/models", { format: fmt, url, key, side: "" });
    setList(l);
    if (l.ok) setUrl(l.url);
    setBusy(false);
  };
  const builtin = preset?.builtinKey && !isUrl;
  const add = async () => {
    setBusy(true);
    const models = [
      ...picked,
      ...manual
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    ];
    const r = builtin
      ? await save({ keys: { [preset?.builtinKey as string]: key } })
      : await save({
          llm: {
            endpoints: [
              ...(s.llm?.endpoints ?? []),
              { name: name || "Endpoint", format: fmt, url, key, models, tier },
            ],
          },
        });
    setR(r);
    setBusy(false);
    if (r.ok) done();
  };
  const shown = useMemo(
    () =>
      list?.ok ? list.models.filter((m) => m.toLowerCase().includes(filter.toLowerCase())).slice(0, 200) : [],
    [list, filter],
  );
  const canAdd = builtin || ((picked.length > 0 || manual.trim() !== "") && /^https?:\/\//.test(url));
  return (
    <div className="add-source">
      <label className="set-field">
        <span className="label dim">PASTE AN API KEY, OR THE ADDRESS OF A MODEL SERVER</span>
        <input
          className="field plain"
          type={isUrl || input === "" ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…  ·  gsk_…  ·  AIza…  ·  http://127.0.0.1:11434/v1"
          value={input}
          onChange={(e) => onPaste(e.target.value)}
        />
      </label>
      <div className="preset-row">
        <span className="cost">or pick:</span>
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className="chip"
            aria-pressed={preset?.id === p.id}
            onClick={() => choose(p)}
          >
            {p.name}
          </button>
        ))}
      </div>
      {preset && (
        <p className="cost">
          <b>{preset.name}.</b> {preset.note}{" "}
          {preset.keyUrl && !key && <Ext href={preset.keyUrl}>Get a key →</Ext>}
        </p>
      )}
      {builtin ? (
        <p className="cost">
          Recognized: a {preset?.name} key. It uses CORTEX's tested models for this provider:{" "}
          {(s.freeChains?.[preset?.id ?? ""] ?? []).join(", ") || "its verified models"}.
        </p>
      ) : (
        (preset || isUrl || key) && (
          <>
            <div className="set-grid">
              <label className="set-field">
                <span className="label dim">NAME</span>
                <input className="field plain" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="set-field">
                <span className="label dim">ADDRESS (BASE URL)</span>
                <input
                  className="field plain"
                  value={url}
                  onChange={(e) => setUrl(e.target.value.trim())}
                  placeholder="https://…/v1"
                />
              </label>
              <label className="set-field">
                <span className="label dim">SPEAKS</span>
                <select
                  className="field plain"
                  value={fmt}
                  onChange={(e) => setFmt(e.target.value as "openai" | "anthropic")}
                >
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic-compatible</option>
                </select>
              </label>
              <label className="set-field">
                <span className="label dim">COSTS</span>
                <select
                  className="field plain"
                  value={tier}
                  onChange={(e) => setTier(e.target.value as Tier)}
                >
                  <option value="free">Free tier</option>
                  <option value="paid">Paid</option>
                  <option value="local">On my computer</option>
                </select>
              </label>
            </div>
            <div className="set-actions">
              <button
                type="button"
                className="chip"
                disabled={busy || !/^https?:\/\//.test(url)}
                onClick={() => void discover()}
              >
                {busy ? "LOOKING…" : "FIND MODELS"}
              </button>
            </div>
            {list && !list.ok && (
              <p className="note-line amber">
                Couldn't list models here ({list.error}). Type the model name(s) below exactly as the provider
                spells them.
              </p>
            )}
            {list?.ok && (
              <>
                <input
                  className="field plain"
                  placeholder={`filter ${list.models.length} models`}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div className="model-pick">
                  {shown.map((m) => (
                    <label key={m} className="model-opt">
                      <input
                        type="checkbox"
                        checked={picked.includes(m)}
                        onChange={(e) =>
                          setPicked((p) => (e.target.checked ? [...p, m] : p.filter((x) => x !== m)))
                        }
                      />
                      {m}
                    </label>
                  ))}
                </div>
              </>
            )}
            {list && (
              <label className="set-field">
                <span className="label dim">
                  MODEL NAME(S), COMMA-SEPARATED {list.ok ? "(OPTIONAL)" : ""}
                </span>
                <input className="field plain" value={manual} onChange={(e) => setManual(e.target.value)} />
              </label>
            )}
          </>
        )
      )}
      {(builtin || list) && (
        <div className="set-actions">
          <button type="button" className="chip go" disabled={!canAdd || busy} onClick={() => void add()}>
            {builtin
              ? "SAVE KEY"
              : `ADD ${picked.length + manual.split(",").filter((x) => x.trim()).length || ""} MODEL(S)`}
          </button>
        </div>
      )}
      <Note r={r} />
    </div>
  );
}

function EndpointRow({ e, s, save }: { e: EndpointView; s: SettingsView; save: Save }) {
  const [r, setR] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const all = s.llm?.endpoints ?? [];
  const others = all.filter((x) => x.id !== e.id);
  // edits keep the endpoint's place in the list (order = which models are tried first)
  const withThis = (next: EndpointView) => all.map((x) => (x.id === e.id ? next : x));
  const test = async (model: string) => {
    setBusy(true);
    setR(await post<Result>("/api/settings/test", { kind: "model", endpoint: e.id, model }));
    setBusy(false);
  };
  return (
    <li className="ep">
      <div className="ep-head">
        <b>{e.name}</b> <span className={`tier ${e.tier}`}>{e.tier.toUpperCase()}</span>
        <span className="dimtext"> {e.url}</span>
        {e.keySet && <span className="dimtext"> · key {e.keyHint}</span>}
        <span className="spacer" />
        <label className="toggle">
          <input
            type="checkbox"
            checked={e.enabled}
            onChange={async (ev) =>
              setR(await save({ llm: { endpoints: withThis({ ...e, enabled: ev.target.checked }) } }))
            }
          />
          ON
        </label>
        <button
          type="button"
          className="chip"
          onClick={async () => {
            if (confirm(`Remove ${e.name}?`)) setR(await save({ llm: { endpoints: others } }));
          }}
        >
          REMOVE
        </button>
      </div>
      <label className="cap">
        <span className="dimtext">
          Max calls per day (blank = no limit; set it under a free tier's daily limit)
        </span>
        <input
          className="field plain"
          type="number"
          min={1}
          defaultValue={e.daily_cap ?? ""}
          onBlur={async (ev) => {
            const v = Number(ev.target.value);
            const next = { ...e, daily_cap: Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined };
            if (next.daily_cap !== e.daily_cap) setR(await save({ llm: { endpoints: withThis(next) } }));
          }}
        />
      </label>
      <div className="ep-models">
        {e.models.map((m) => (
          <span key={m} className="model-tag">
            {m}
            <button type="button" aria-label={`Test ${m}`} disabled={busy} onClick={() => void test(m)}>
              test
            </button>
            <button
              type="button"
              aria-label={`Remove ${m}`}
              onClick={async () =>
                setR(
                  await save({
                    llm: { endpoints: withThis({ ...e, models: e.models.filter((x) => x !== m) }) },
                  }),
                )
              }
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <Note r={r} />
    </li>
  );
}

function BuiltinRow({
  s,
  save,
  id,
  label,
  keyName,
  keyUrl,
}: {
  s: SettingsView;
  save: Save;
  id: string;
  label: string;
  keyName: string;
  keyUrl: string;
}) {
  const k = s.keys?.[keyName];
  const [r, setR] = useState<Result | null>(null);
  if (!k?.set) return null;
  return (
    <li className="ep">
      <div className="ep-head">
        <b>{label}</b> <span className="tier free">FREE</span>
        <span className="dimtext">
          {" "}
          · key {k.hint} · tested models: {(s.freeChains?.[id] ?? []).join(", ")}
        </span>
        <span className="spacer" />
        <Ext href={keyUrl}>manage key</Ext>
        <button
          type="button"
          className="chip"
          onClick={async () => setR(await save({ keys: { [keyName]: null } }))}
        >
          REMOVE
        </button>
      </div>
      <Note r={r} />
    </li>
  );
}

interface ScoreRow {
  provider: string;
  model: string;
  calls: number;
  ok: number;
  schema_fail: number;
  rate_limited: number;
  timeouts: number;
  errors: number;
  avg_ok_ms: number | null;
}

/** ADR-072: how each model in the pool did over 7 days, from the brain's own call log. */
function Scoreboard({ s }: { s: SettingsView }) {
  const r = useResource<ScoreRow[]>("/api/models", 60_000);
  const names = Object.fromEntries((s.llm?.endpoints ?? []).map((e) => [`ep:${e.id}`, e.name]));
  if (!r.data || r.data.length === 0)
    return (
      <p className="cost">
        No court calls in the last 7 days yet. Each model's record appears here once it's used.
      </p>
    );
  return (
    <div className="scroll-x">
      <table className="ecam stack">
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Calls</th>
            <th className="num">Answered</th>
            <th className="num">Bad format</th>
            <th className="num">Busy / slow</th>
            <th className="num">Avg time</th>
          </tr>
        </thead>
        <tbody>
          {r.data.map((x) => {
            const rate = x.calls ? x.ok / x.calls : 0;
            return (
              <tr key={`${x.provider}/${x.model}`}>
                <td className="w" data-label="MODEL">
                  {x.model}{" "}
                  <span className="dimtext">· {names[x.provider.replace(/~bear$/, "")] ?? x.provider}</span>
                </td>
                <td className="num" data-label="CALLS">
                  {x.calls}
                </td>
                <td className={`num ${rate >= 0.8 ? "" : rate >= 0.5 ? "a" : "r"}`} data-label="ANSWERED">
                  {Math.round(rate * 100)}%
                </td>
                <td className="num" data-label="BAD FORMAT">
                  {x.schema_fail}
                </td>
                <td className="num" data-label="BUSY / SLOW">
                  {x.rate_limited + x.timeouts}
                </td>
                <td className="num" data-label="AVG TIME">
                  {x.avg_ok_ms === null ? "—" : `${(x.avg_ok_ms / 1000).toFixed(1)} s`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ModelsSection({ s, save, saving }: { s: SettingsView; save: Save; saving: boolean }) {
  const [adding, setAdding] = useState((s.pool?.entries.length ?? 0) === 0);
  const [found, setFound] = useState<
    { preset: string; name: string; url: string; models: string[] }[] | null
  >(null);
  const [r, setR] = useState<Result | null>(null);
  const prefs = s.llm?.prefs ?? { prefer: "free_first", round_robin: true, allow_same_model: false };
  const setPrefs = async (p: Partial<PoolPrefs>) => setR(await save({ llm: { prefs: { ...prefs, ...p } } }));
  const single = (s.pool?.models ?? 0) === 1;
  return (
    <section className="set-sec">
      <h4>AI models</h4>
      <p className="cost">
        The court argues every trade with at least two different models: one makes the case, another attacks
        it. Add as many as you like, free or paid: CORTEX rotates through all of them (so free limits last
        longer) and falls back to the next when one fails. <b>Two or more models</b> from different companies
        work best.
      </p>
      <PoolStatus s={s} />
      {single && (
        <label className="toggle warn">
          <input
            type="checkbox"
            checked={prefs.allow_same_model}
            disabled={saving}
            onChange={(e) => void setPrefs({ allow_same_model: e.target.checked })}
          />
          Let this one model argue both sides. Not recommended: the bear tends to agree with the bull, so
          fewer bad trades get caught. Tick only if you understand that; adding a second model is better.
        </label>
      )}
      <ul className="ep-list">
        <BuiltinRow
          s={s}
          save={save}
          id="gemini"
          label="Google Gemini"
          keyName="GEMINI_API_KEY"
          keyUrl="https://aistudio.google.com/apikey"
        />
        <BuiltinRow
          s={s}
          save={save}
          id="groq"
          label="Groq"
          keyName="GROQ_API_KEY"
          keyUrl="https://console.groq.com/keys"
        />
        <BuiltinRow
          s={s}
          save={save}
          id="nim"
          label="NVIDIA NIM"
          keyName="NVIDIA_API_KEY"
          keyUrl="https://build.nvidia.com/settings/api-keys"
        />
        {(s.llm?.endpoints ?? []).map((e) => (
          <EndpointRow key={e.id} e={e} s={s} save={save} />
        ))}
      </ul>
      {adding ? (
        <AddSource s={s} save={save} done={() => setAdding(false)} />
      ) : (
        <div className="set-actions">
          <button type="button" className="chip go" onClick={() => setAdding(true)}>
            + ADD MODELS
          </button>
          <button
            type="button"
            className="chip"
            onClick={async () =>
              setFound((await post<{ found: typeof found }>("/api/settings/detect", {})).found ?? [])
            }
          >
            FIND MODELS ON THIS COMPUTER
          </button>
        </div>
      )}
      {found && (
        <div className="found">
          {found.length === 0 ? (
            <p className="cost">
              No local model server found. Install <Ext href="https://ollama.com/download">Ollama</Ext> or{" "}
              <Ext href="https://lmstudio.ai">LM Studio</Ext>, download a model, and look again.
            </p>
          ) : (
            found.map((f) => (
              <p key={f.url} className="cost">
                <b>{f.name}</b>: {f.models.slice(0, 8).join(", ")}{" "}
                <button
                  type="button"
                  className="chip"
                  onClick={async () =>
                    setR(
                      await save({
                        llm: {
                          endpoints: [
                            ...(s.llm?.endpoints ?? []),
                            {
                              name: f.name.replace(/ \(.*\)$/, ""),
                              format: "openai",
                              url: f.url,
                              key: "",
                              models: f.models.slice(0, 3),
                              tier: "local",
                            },
                          ],
                        },
                      }),
                    )
                  }
                >
                  USE {Math.min(3, f.models.length)}
                </button>
              </p>
            ))
          )}
        </div>
      )}
      <details className="advanced">
        <summary className="label dim">HOW THE MODELS ARE DOING (7 DAYS)</summary>
        <Scoreboard s={s} />
      </details>
      <details className="advanced">
        <summary className="label dim">HOW THE MODELS ARE USED</summary>
        <div className="choice-row" role="radiogroup" aria-label="Order">
          {(
            [
              [
                "free_first",
                "Free first",
                "Free and local models do the work; paid ones step in when they fail or run out.",
              ],
              ["paid_first", "Paid first", "Your paid models lead; free ones are the backup."],
              ["mixed", "Mix", "One rotation across everything."],
            ] as const
          ).map(([id, t, d]) => (
            <button
              key={id}
              type="button"
              className="choice"
              aria-pressed={prefs.prefer === id}
              disabled={saving}
              onClick={() => void setPrefs({ prefer: id })}
            >
              <b>{t}</b>
              <span>{d}</span>
            </button>
          ))}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={prefs.round_robin}
            disabled={saving}
            onChange={(e) => void setPrefs({ round_robin: e.target.checked })}
          />
          Round robin: start with a different model each time (spreads free limits). Off: always try in order.
        </label>
        {!single && prefs.allow_same_model && (
          <label className="toggle warn">
            <input
              type="checkbox"
              checked={prefs.allow_same_model}
              disabled={saving}
              onChange={(e) => void setPrefs({ allow_same_model: e.target.checked })}
            />
            Let one model argue both sides. Not recommended: the bear tends to agree with the bull, so fewer
            bad trades get caught. Tick only if you understand that.
          </label>
        )}
      </details>
      <Note r={r} />
    </section>
  );
}

// ------------------------------------------------------------------ Clef + Clairic (Cloudflare AI)

export function ClefSection({ s, save, saving }: { s: SettingsView; save: Save; saving: boolean }) {
  const [acct, setAcct] = useState("");
  const [tok, setTok] = useState("");
  const [r, setR] = useState<Result | null>(null);
  const k = s.keys ?? {};
  const c = s.clef;
  return (
    <section className="set-sec">
      <h4>News triage and fact reading (Cloudflare AI)</h4>
      <p className={`note-line ${c?.level === "ok" ? "green" : "amber"}`}>{c?.text}</p>
      <p className="cost">
        Clef sorts the news and judges each hearing; Clairic pulls the numbers out of announcements. They run
        on Cloudflare's Workers AI, which has a <b>free daily allowance</b>. Without it, your own AI model
        stands in: it works, but performance is marginally lower. Get the two values from{" "}
        <Ext href="https://dash.cloudflare.com/?to=/:account/ai/workers-ai">
          Cloudflare → AI → Workers AI → Use REST API
        </Ext>
        .
      </p>
      <div className="set-grid">
        <Secret label="ACCOUNT ID" hint={k.CLOUDFLARE_ACCOUNT_ID?.hint} value={acct} onChange={setAcct} />
        <Secret
          label="API TOKEN (WORKERS AI)"
          hint={k.CLOUDFLARE_API_TOKEN?.hint}
          value={tok}
          onChange={setTok}
        />
      </div>
      <div className="set-actions">
        <button
          type="button"
          className="chip"
          onClick={async () =>
            setR(
              await post<Result>("/api/settings/test", { kind: "cloudflare", accountId: acct, token: tok }),
            )
          }
        >
          TEST
        </button>
        <button
          type="button"
          className="chip go"
          disabled={saving || (!acct && !tok)}
          onClick={async () =>
            setR(
              await save({
                keys: {
                  ...(acct ? { CLOUDFLARE_ACCOUNT_ID: acct } : {}),
                  ...(tok ? { CLOUDFLARE_API_TOKEN: tok } : {}),
                },
              }),
            )
          }
        >
          SAVE
        </button>
      </div>
      <Note r={r} />
    </section>
  );
}

// ------------------------------------------------------------------ alerts

function randomTopic(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `cortex-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function AlertsSection({ s, save, saving }: { s: SettingsView; save: Save; saving: boolean }) {
  const [token, setToken] = useState("");
  const [guild, setGuild] = useState("");
  const [d, setD] = useState<
    (Result & { inviteUrl?: string; guilds?: { id: string; name: string }[] }) | null
  >(null);
  const [r, setR] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const connect = async (g = guild) => {
    setBusy(true);
    setD(await post("/api/settings/discord", { token, guildId: g }));
    setBusy(false);
  };
  return (
    <section className="set-sec">
      <h4>Alerts</h4>
      <p className="cost">
        Everything always appears in the FEED. These send it to your phone or Discord too.
      </p>
      <div className="alert-opt">
        <b>Phone</b>
        {s.push?.url ? (
          <p className="cost">
            On. Install the free <Ext href="https://ntfy.sh">ntfy</Ext> app and subscribe to{" "}
            <code className="sel">{s.push.url}</code>. Only alarms, trades and blocked entries are pushed.{" "}
            <button
              type="button"
              className="chip"
              onClick={async () => setR(await save({ keys: { NTFY_TOPIC: null } }))}
            >
              TURN OFF
            </button>
          </p>
        ) : (
          <p className="cost">
            Get pushes for alarms and trades through the free ntfy app (no account).{" "}
            <button
              type="button"
              className="chip go"
              disabled={saving}
              onClick={async () => setR(await save({ keys: { NTFY_TOPIC: randomTopic() } }))}
            >
              TURN ON
            </button>
          </p>
        )}
      </div>
      <div className="alert-opt">
        <b>Discord (optional)</b>
        {s.discord?.connected ? (
          <p className="cost">
            Connected: {s.discord.channels.length} channels in a private CORTEX-54 category.{" "}
            <button
              type="button"
              className="chip"
              onClick={async () =>
                setR(await save({ keys: { DISCORD_BOT_TOKEN: null, DISCORD_CHANNELS: null } }))
              }
            >
              DISCONNECT
            </button>
          </p>
        ) : (
          <>
            <p className="cost">
              Create a bot at{" "}
              <Ext href="https://discord.com/developers/applications">discord.com/developers</Ext> (New
              Application → Bot → Reset Token), paste the token, and press Connect. CORTEX creates its own
              private channels.
            </p>
            <div className="set-grid">
              <Secret label="BOT TOKEN" value={token} onChange={setToken} />
            </div>
            <div className="set-actions">
              <button
                type="button"
                className="chip go"
                disabled={busy || !token}
                onClick={() => void connect()}
              >
                {busy ? "CONNECTING…" : "CONNECT"}
              </button>
            </div>
          </>
        )}
        {d && (
          <div>
            <p className={`note-line ${d.ok ? "green" : "amber"}`}>{d.message}</p>
            {d.inviteUrl && (
              <p className="cost">
                <Ext href={d.inviteUrl}>Add the bot to your server →</Ext> then press Connect again.
              </p>
            )}
            {d.guilds && (
              <div className="preset-row">
                {d.guilds.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setGuild(g.id);
                      void connect(g.id);
                    }}
                  >
                    {g.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <Note r={r} />
    </section>
  );
}

// ------------------------------------------------------------------ health + support (ADR-073)

interface CheckRow {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  warn?: boolean;
}

export function HealthSection() {
  const [rows, setRows] = useState<CheckRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setRows((await post<{ checks: CheckRow[] }>("/api/settings/checks", {})).checks);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    const data = await post<Record<string, unknown>>("/api/settings/support", {});
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `cortex-support-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="set-sec">
      <h4>Health</h4>
      <p className="cost">Checks everything the robot needs, in plain words. Same as `cortex doctor`.</p>
      <div className="set-actions">
        <button type="button" className="chip go" disabled={busy} onClick={() => void run()}>
          {busy ? "CHECKING…" : "RUN CHECKS"}
        </button>
        <button type="button" className="chip" onClick={() => void download()}>
          SAVE A SUPPORT FILE
        </button>
      </div>
      <p className="cost">
        The support file holds versions, settings and check results, never your keys. Open it to see exactly
        what's in it before you send it to anyone.
      </p>
      {rows && (
        <ul className="onb-progress">
          {rows.map((r) => (
            <li key={r.name} className={!r.ok ? "red" : r.warn ? "amber" : "green"}>
              {!r.ok ? "✗" : r.warn ? "•" : "✓"} <b>{r.name}</b>: {r.detail}
              {(!r.ok || r.warn) && r.fix && <span className="dimtext"> → {r.fix}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ page

export function SettingsPage({
  s,
  reload,
  restartOnboarding,
}: {
  s: SettingsView | null;
  reload: () => void;
  restartOnboarding: () => void;
}) {
  const { save, saving } = useSaver(reload);
  if (!s) return <p className="empty">Loading settings…</p>;
  if (s.managed === "cloud") return <p className="empty">{s.message}</p>;
  return (
    <div className="settings">
      {saving && <p className="note-line cyan">Applying…</p>}
      <TradingSection s={s} save={save} saving={saving} />
      <ModelsSection s={s} save={save} saving={saving} />
      <ClefSection s={s} save={save} saving={saving} />
      <AlertsSection s={s} save={save} saving={saving} />
      <HealthSection />
      <section className="set-sec">
        <h4>Setup</h4>
        <p className="cost">Run the guided setup again, or hand it to an AI agent.</p>
        <button type="button" className="chip" onClick={restartOnboarding}>
          OPEN SETUP
        </button>
      </section>
    </div>
  );
}
