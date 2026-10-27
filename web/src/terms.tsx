import { useState } from "react";
import { post, type SettingsView } from "./api.ts";

/**
 * First-launch terms (ADR-087): before Savant may trade a broker account, the user reads the short risk summary and
 * accepts the terms, licence (EULA) and risk disclosure. Shown again whenever the legal set's version changes. The
 * demo keeps working without it; new entries on a real account are held until it is accepted.
 */
export function TermsGate({ s, reload }: { s: SettingsView; reload: () => void }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const again = s.terms?.acceptedAt != null;
  const accept = async () => {
    setBusy(true);
    const r = await post<{ ok: boolean; message: string }>("/api/settings/terms", { accept: true });
    setBusy(false);
    if (r.ok) reload();
    else setErr(r.message);
  };
  const doc = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Terms and risk">
      <div className="onb-card">
        <p className="label dim">{again ? "UPDATED TERMS" : "BEFORE YOU START"}</p>
        <h2 className="onb-title">Savant trades real accounts. Please read this first.</h2>
        <ul className="terms-points">
          <li>
            Savant is software that places trades on your own broker account without asking you first. It can
            and will lose money; you can lose everything in the account.
          </li>
          <li>
            It is not financial advice, and nobody at Savant reviews your trades. Past or simulated results
            don't predict future results.
          </li>
          <li>
            Live (real-money) trading stays off until you switch it on yourself. You can pause, flatten or
            kill it at any time.
          </li>
          <li>
            Your keys and your journal stay on this computer. The licence check sends only your licence key
            and a one-way fingerprint of this computer.
          </li>
        </ul>
        <p className="cost">
          Full text: {doc("/legal/terms.html", "Terms of Service")} ·{" "}
          {doc("/legal/eula.html", "Licence (EULA)")} · {doc("/legal/risk.html", "Risk disclosure")} ·{" "}
          {doc("/legal/privacy.html", "Privacy")} · {doc("/legal/refunds.html", "Refunds")}
        </p>
        <label className="toggle">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>I have read and accept the Terms, the Licence and the Risk disclosure.</span>
        </label>
        {err && <p className="red">{err}</p>}
        <div className="onb-nav">
          <button type="button" className="onb-btn primary" disabled={!ok || busy} onClick={accept}>
            {busy ? "Saving…" : "Accept and continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
