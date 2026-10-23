import { useState } from "react";
import type { AccountView } from "./api.ts";

/** Valid autonomy stops per account (CLAUDE.md §6): no approve-each-trade stop exists. */
const STOPS: Record<string, number[]> = { PAPER: [0, 2, 4], LIVE: [0, 3, 4] };
const STOP_NAME: Record<number, string> = { 0: "SHADOW", 2: "AUTONOMOUS", 3: "LIVE AUTO", 4: "COLLEAGUE" };

type Run = (name: string, args: Record<string, unknown>) => Promise<void>;

/** A guarded pushbutton: lift the red guard (first action), then press (second). The guard drops after 8 s. */
function Guarded(props: {
  label: string;
  legend: string;
  onPress: () => void;
  disabled?: boolean;
  caption?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ctl">
      <div className={`guarded ${open ? "open" : ""}`}>
        <button
          type="button"
          className="guard"
          aria-label={`Lift guard: ${props.label}`}
          disabled={props.disabled}
          onClick={() => {
            setOpen(true);
            setTimeout(() => setOpen(false), 8000);
          }}
        />
        <button
          type="button"
          className="pb"
          aria-label={props.label}
          tabIndex={open ? 0 : -1}
          onClick={() => {
            setOpen(false);
            props.onPress();
          }}
        >
          <span className="on-amber">{props.legend}</span>
          <span className="on-white">PUSH</span>
        </button>
      </div>
      {props.caption ?? props.label}
    </div>
  );
}

export function AccountPanel({ a, run, busy }: { a: AccountView; run: Run; busy: boolean }) {
  const [pending, setPending] = useState<number | null>(null);
  const [ratify, setRatify] = useState("");
  const [pm, setPm] = useState("");
  const paused = a.mode === "PAUSED";
  const stops = STOPS[a.account] ?? [];
  const needsRatify = a.account === "LIVE" && pending !== null && pending > 0;
  return (
    <section className="ovh" aria-label={`${a.account} controls`}>
      <div className="ovh-title">
        <span>{a.account}</span>
        <span>
          {a.configured ? `STOP ${a.autonomyStop} · ${STOP_NAME[a.autonomyStop] ?? ""}` : "NO KEYS"}
        </span>
      </div>
      <div className="ovh-row">
        <div className="ctl">
          <button
            type="button"
            className="pb"
            aria-pressed={paused}
            disabled={!a.configured || busy}
            aria-label={paused ? `Resume ${a.account} entries` : `Pause ${a.account} entries`}
            onClick={() => void run(paused ? "resume" : "pause", { account: a.account })}
          >
            <span className={paused ? "on-amber" : ""}>PAUSED</span>
            <span className={paused ? "on-white" : ""}>{paused ? "RESUME" : "OFF"}</span>
          </button>
          Entries
        </div>
        <div className="ctl">
          <fieldset className="rotary" aria-label={`${a.account} autonomy stop`}>
            {[0, 1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={pending === null ? a.autonomyStop === n : false}
                className={pending === n ? "pending" : ""}
                disabled={!stops.includes(n) || !a.configured || busy}
                aria-label={`Stop ${n}${STOP_NAME[n] ? ` ${STOP_NAME[n]}` : ""}`}
                onClick={() => setPending(n === a.autonomyStop ? null : n)}
              >
                {n}
              </button>
            ))}
          </fieldset>
          Autonomy
        </div>
        {pending !== null && needsRatify && (
          <Guarded
            label={`Ratify LIVE stop ${pending}: real money trades on its own`}
            caption="Ratify"
            legend="RATIFY"
            disabled={busy || ratify !== "RATIFY"}
            onPress={() => {
              void run("dial", { account: a.account, stop: pending, confirm: ratify });
              setPending(null);
              setRatify("");
            }}
          />
        )}
        {pending !== null && !needsRatify && (
          <div className="ctl">
            <button
              type="button"
              className="pb"
              disabled={busy}
              onClick={() => {
                void run("dial", { account: a.account, stop: pending });
                setPending(null);
                setRatify("");
              }}
            >
              <span className="on-cyan">SET</span>
              <span className="on-white">{pending}</span>
            </button>
            Confirm
          </div>
        )}
        <Guarded
          label={`Flatten ${a.account}`}
          legend="FLAT"
          disabled={!a.configured || busy}
          onPress={() => void run("flatten", { account: a.account })}
        />
      </div>
      {needsRatify && (
        <input
          className="field"
          aria-label="Type RATIFY to let LIVE trade real money"
          placeholder="Type RATIFY to let LIVE trade real money"
          value={ratify}
          onChange={(e) => setRatify(e.target.value.toUpperCase())}
        />
      )}
      {a.locked && (
        <div className="ovh-row" style={{ alignItems: "stretch" }}>
          <textarea
            className="field"
            aria-label={`${a.account} postmortem`}
            placeholder="Written postmortem: what tripped RED, and why it is safe to trade again"
            value={pm}
            onChange={(e) => setPm(e.target.value)}
          />
          <button
            type="button"
            className="pb"
            disabled={busy || pm.trim().length < 50}
            onClick={() => void run("unlock", { account: a.account, postmortem: pm })}
          >
            <span className="on-amber">LOCK</span>
            <span className="on-white">UNLOCK</span>
          </button>
        </div>
      )}
    </section>
  );
}

export function CourtPanel({ run, busy }: { run: Run; busy: boolean }) {
  const [sym, setSym] = useState("");
  const ok = /^[A-Z.]{1,8}(\/USD)?$/.test(sym.trim());
  return (
    <section className="ovh" aria-label="Convene the court" data-guide="court">
      <div className="ovh-title">
        <span>Court</span>
        <span>PAPER ONLY · ALL GATES APPLY</span>
      </div>
      <div className="ovh-row">
        <input
          className="field"
          aria-label="Symbol"
          placeholder="BTC/USD or NVDA"
          value={sym}
          onChange={(e) => setSym(e.target.value.toUpperCase())}
        />
        <div className="ctl">
          <button
            type="button"
            className="pb"
            disabled={!ok || busy}
            onClick={() => void run("court", { symbol: sym.trim() })}
          >
            <span className={ok ? "on-cyan" : ""}>CONVENE</span>
            <span className={ok ? "on-white" : ""}>PUSH</span>
          </button>
          Session
        </div>
      </div>
      <p className="cost">
        Every control on this panel is journaled as an operator action and{" "}
        <b>restarts the 30-day autonomous clock</b> that gates real money. The safest input is usually none.
      </p>
    </section>
  );
}
