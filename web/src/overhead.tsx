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

type Gate = { at: number; rows: { criterion: string; status: string; value: string }[] } | null;

export function AccountPanel({
  a,
  run,
  busy,
  gate = null,
}: {
  a: AccountView;
  run: Run;
  busy: boolean;
  gate?: Gate;
}) {
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
        {/* after a flatten (or any reduce-only hold) the account stays exits-only until the operator resumes it */}
        {a.configured && a.mode === "REDUCE_ONLY" && !a.locked && (
          <div className="ctl">
            <button
              type="button"
              className="pb"
              disabled={busy}
              aria-label={`Resume ${a.account} new entries`}
              title={a.modeReason ?? undefined}
              onClick={() => void run("resume", { account: a.account })}
            >
              <span className="on-amber">REDUCE</span>
              <span className="on-white">RESUME</span>
            </button>
            Resume
          </div>
        )}
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
          <RatifyBox
            stop={pending}
            gate={gate}
            value={ratify}
            onChange={setRatify}
            busy={busy}
            onConfirm={() => {
              void run("dial", { account: "LIVE", stop: pending, confirm: "RATIFY" });
              setRatify("");
              setPending(null);
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
          onPress={() => void run("flatten", { account: a.account, confirm: "FLATTEN" })}
        />
      </div>

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

/**
 * ADR-083: turning on real-money trading from the app. Typing RATIFY sends one confirmation; the brain asks for a
 * second one 10 minutes to 24 hours later, and both need a sign-in younger than 10 minutes. The Governor's paper
 * graduation gate is shown, and a gate that hasn't passed is a loud warning, not a block (operator decision).
 */
function RatifyBox(props: {
  stop: number;
  gate: Gate;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onConfirm: () => void;
}) {
  const data = (props.gate?.rows ?? []).filter((r) => r.criterion.startsWith("(b)") && r.status !== "INFO");
  const failing = data.filter((r) => r.status !== "PASS");
  const passed = props.gate !== null && data.length > 0 && failing.length === 0;
  return (
    <fieldset className="ratify" aria-label="Turn on real-money trading">
      <p className={`sub ${passed ? "" : "red"}`}>
        {props.gate === null
          ? "⚠ The paper account has no graduation report yet. Real money before the paper run has proven itself is at your own risk."
          : passed
            ? "Paper graduation gate: passed."
            : `⚠ The paper account has NOT passed its graduation gate (${failing.length} of ${data.length} checks open). Real money now is at your own risk.`}
      </p>
      {failing.length > 0 && (
        <ul className="ratify-gate">
          {failing.slice(0, 6).map((r) => (
            <li key={r.criterion}>
              {r.criterion.replace(/^\(b\)\s*/, "")}: {r.status === "WAIT" ? "not enough data" : r.value}
            </li>
          ))}
        </ul>
      )}
      <p className="sub">
        Stop {props.stop} lets CORTEX trade your <b>real money</b> on its own, inside the same risk limits.
        Type RATIFY to confirm. You'll confirm once more, 10 minutes to 24 hours from now, on a fresh sign-in.
      </p>
      <input
        className="field"
        aria-label="Type RATIFY"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete="off"
        placeholder="RATIFY"
      />
      <button
        type="button"
        className="pb"
        disabled={props.busy || props.value !== "RATIFY"}
        onClick={props.onConfirm}
      >
        <span className="on-amber">RATIFY</span>
        <span className="on-white">{props.stop}</span>
      </button>
    </fieldset>
  );
}
