import { useState } from "react";
import type { SettingsView } from "./api.ts";
import { AlertsSection, ClefSection, ModelsSection, TradingSection, useSaver } from "./settings.tsx";

/**
 * First-launch onboarding (ADR-073). Two ways in: a guided wizard (the same sections as SETTINGS, one at a time, in
 * plain words), or a prompt to paste into any AI agent that can run commands (it asks for each key and configures
 * everything with the `cortex` CLI; the app picks up its changes live). Either way can be left and resumed.
 */
const STEPS = ["Account", "AI models", "Cloudflare AI", "Alerts", "Done"] as const;

export function Onboarding({ s, reload, close }: { s: SettingsView; reload: () => void; close: () => void }) {
  const [path, setPath] = useState<"choose" | "wizard" | "agent">("choose");
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const { save, saving } = useSaver(reload);
  const blocked = s.pool?.notes.some((n) => n.level === "block") ?? true;
  const finish = async () => {
    const r = await save({ onboarded: true });
    if (r.ok) close();
  };

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Set up CORTEX-54">
      <div className="onb-card">
        {path === "choose" && (
          <>
            <p className="label dim">WELCOME</p>
            <h2 className="onb-title">Let's get your robot ready.</h2>
            <p className="onb-lead">
              CORTEX-54 trades a small paper account on its own: it reads the news, argues every trade with
              two AI models, and a risk engine decides the size. Right now it is running in <b>demo mode</b>{" "}
              with no keys. Pick how you'd like to finish setting it up. You can change anything later in
              SETTINGS.
            </p>
            <div className="onb-choices">
              <button type="button" className="onb-choice" onClick={() => setPath("wizard")}>
                <b>Guide me</b>
                <span>Five short steps with links to every free key. About 5 minutes.</span>
              </button>
              <button type="button" className="onb-choice" onClick={() => setPath("agent")}>
                <b>Let my AI agent do it</b>
                <span>
                  Copy one prompt into Claude Code, Codex, Cursor or any agent that runs commands. It asks you
                  for each key and sets everything up.
                </span>
              </button>
            </div>
            <button type="button" className="onb-skip" onClick={close}>
              Just look around in demo mode first
            </button>
          </>
        )}

        {path === "agent" && (
          <>
            <p className="label dim">SET UP WITH AN AI AGENT</p>
            <h2 className="onb-title">Paste this into your agent.</h2>
            <p className="onb-lead">
              It asks for one thing at a time and tells you where to get it. Changes show up here within
              seconds. Prefer not to paste keys into a chat? Tell the agent; it will let you type them in your
              own terminal.
            </p>
            <pre className="onb-prompt">{s.agentPrompt}</pre>
            <div className="onb-nav">
              <button type="button" className="onb-btn" onClick={() => setPath("choose")}>
                Back
              </button>
              <button
                type="button"
                className="onb-btn primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(s.agentPrompt ?? "");
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? "Copied ✓" : "Copy prompt"}
              </button>
              <button type="button" className="onb-btn" onClick={reload}>
                Check progress
              </button>
            </div>
            <Progress s={s} />
            {s.onboarded && (
              <button type="button" className="onb-btn primary" onClick={close}>
                All set: open the dashboard
              </button>
            )}
          </>
        )}

        {path === "wizard" && (
          <>
            <ol className="onb-steps" aria-label="Steps">
              {STEPS.map((t, i) => (
                <li key={t} aria-current={i === step ? "step" : undefined} className={i < step ? "done" : ""}>
                  <button type="button" onClick={() => setStep(i)}>
                    {i + 1}. {t}
                  </button>
                </li>
              ))}
            </ol>
            {step === 0 && (
              <>
                <p className="onb-lead">
                  Start in <b>demo</b> (nothing to set up) or connect a free <b>paper</b> account: fake money,
                  real market, and the robot gets stocks and news too.
                </p>
                <TradingSection s={s} save={save} saving={saving} />
              </>
            )}
            {step === 1 && (
              <>
                <p className="onb-lead">
                  The fastest free start: a <b>Google Gemini</b> key and a <b>Groq</b> key (two minutes each,
                  no card). Paste a key below and CORTEX recognizes it. Add paid models or a model on your own
                  computer any time.
                </p>
                <ModelsSection s={s} save={save} saving={saving} />
              </>
            )}
            {step === 2 && (
              <>
                <p className="onb-lead">
                  Recommended, free: Cloudflare's AI sorts the news and reads the facts out of announcements.
                  Skip it and your own model stands in, with marginally lower performance.
                </p>
                <ClefSection s={s} save={save} saving={saving} />
              </>
            )}
            {step === 3 && (
              <>
                <p className="onb-lead">Optional. Everything always shows up in the app's FEED.</p>
                <AlertsSection s={s} save={save} saving={saving} />
              </>
            )}
            {step === 4 && (
              <>
                <p className="onb-lead">Here's where things stand.</p>
                <Progress s={s} />
                {blocked && (
                  <p className="note-line amber">
                    The court can't run yet: it needs AI models. The robot still manages risk and runs its
                    rule-based strategies; add models any time in SETTINGS.
                  </p>
                )}
              </>
            )}
            <div className="onb-nav">
              <button
                type="button"
                className="onb-btn"
                onClick={() => (step === 0 ? setPath("choose") : setStep(step - 1))}
              >
                Back
              </button>
              {step < 4 ? (
                <button
                  type="button"
                  className="onb-btn primary"
                  disabled={saving}
                  onClick={() => setStep(step + 1)}
                >
                  {step === 2 || step === 3 ? "Next (or skip)" : "Next"}
                </button>
              ) : (
                <button
                  type="button"
                  className="onb-btn primary"
                  disabled={saving}
                  onClick={() => void finish()}
                >
                  Start
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Plain-language checklist of what is set up. */
function Progress({ s }: { s: SettingsView }) {
  const k = s.keys ?? {};
  const items: [boolean | "warn", string][] = [
    [true, s.mode === "paper" ? "Paper account connected" : "Demo mode (simulated $54, live crypto prices)"],
    ...(s.pool?.notes ?? []).map((n): [boolean | "warn", string] => [
      n.level === "ok" ? true : n.level === "warn" ? "warn" : false,
      n.text,
    ]),
    [s.clef?.level === "ok" ? true : s.clef?.level === "degraded" ? "warn" : false, s.clef?.text ?? ""],
    [
      k.NTFY_TOPIC?.set || s.discord?.connected ? true : "warn",
      k.NTFY_TOPIC?.set || s.discord?.connected ? "Alerts on" : "Alerts: in the app only",
    ],
  ];
  return (
    <ul className="onb-progress">
      {items.map(([ok, t]) => (
        <li key={t} className={ok === true ? "green" : ok === "warn" ? "amber" : "red"}>
          {ok === true ? "✓" : ok === "warn" ? "•" : "✗"} {t}
        </li>
      ))}
    </ul>
  );
}
