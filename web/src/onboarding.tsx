import { useState } from "react";
import type { SettingsView } from "./api.ts";
import {
  AlertsSection,
  ClefSection,
  LicenseSection,
  ModelsSection,
  TradingSection,
  useSaver,
} from "./settings.tsx";

/**
 * First-launch onboarding (ADR-073): a guided wizard, the same sections as SETTINGS one at a time, in plain words. It
 * can be left and resumed. (The paste-into-an-agent path was removed from the app by the operator, ADR-083; the
 * `cortex` CLI and docs/SETUP_WITH_AN_AGENT.md still work for people who want it.)
 */
const STEPS = ["Account", "Licence", "AI models", "Cloudflare AI", "Alerts", "Done"] as const;

export function Onboarding({ s, reload, close }: { s: SettingsView; reload: () => void; close: () => void }) {
  const [path, setPath] = useState<"choose" | "wizard">("choose");
  const [step, setStep] = useState(0);
  const { save, saving } = useSaver(reload);
  const blocked = s.pool?.notes.some((n) => n.level === "block") ?? true;
  const finish = async () => {
    const r = await save({ onboarded: true });
    if (r.ok) close();
  };

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Set up Savant">
      <div className="onb-card">
        {path === "choose" && (
          <>
            <p className="label dim">WELCOME</p>
            <h2 className="onb-title">Let's get your robot ready.</h2>
            <p className="onb-lead">
              Savant trades on its own: it reads the news, argues every trade with two AI models, and a risk
              engine decides the size. Right now it is running in <b>demo mode</b> with no keys. Five short
              steps, with links to every free key, finish the setup. You can change anything later in
              SETTINGS.
            </p>
            <div className="onb-nav">
              <button type="button" className="onb-btn primary" onClick={() => setPath("wizard")}>
                Start setup (about 5 minutes)
              </button>
            </div>
            <button type="button" className="onb-skip" onClick={close}>
              Just look around in demo mode first
            </button>
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
                  real market, and the robot gets stocks and news too. A <b>live</b> account (real money) can
                  be connected here too; it stays switched off until you turn it on.
                </p>
                <TradingSection s={s} save={save} saving={saving} />
              </>
            )}
            {step === 1 && (
              <>
                <p className="onb-lead">
                  Demo mode is free, forever. To trade your paper or live account, activate a licence: every
                  plan starts with a <b>7-day free trial</b>, and the key is in your Whop order.
                </p>
                <LicenseSection s={s} reload={reload} />
                {!s.license?.required && (
                  <p className="cost">This build doesn't need a licence. Skip ahead.</p>
                )}
              </>
            )}
            {step === 2 && (
              <>
                <p className="onb-lead">
                  The fastest free start: a <b>Google Gemini</b> key and a <b>Groq</b> key (two minutes each,
                  no card). Paste a key below and Savant recognizes it. Add paid models or a model on your own
                  computer any time.
                </p>
                <ModelsSection s={s} save={save} saving={saving} />
              </>
            )}
            {step === 3 && (
              <>
                <p className="onb-lead">
                  Recommended, free: Cloudflare's AI sorts the news and reads the facts out of announcements.
                  Skip it and your own model stands in, with marginally lower performance.
                </p>
                <ClefSection s={s} save={save} saving={saving} />
              </>
            )}
            {step === 4 && (
              <>
                <p className="onb-lead">Optional. Everything always shows up in the app's FEED.</p>
                <AlertsSection s={s} save={save} saving={saving} />
              </>
            )}
            {step === 5 && (
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
              {step < 5 ? (
                <button
                  type="button"
                  className="onb-btn primary"
                  disabled={saving}
                  onClick={() => setStep(step + 1)}
                >
                  {step >= 1 && step <= 4 && step !== 2 ? "Next (or skip)" : "Next"}
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
