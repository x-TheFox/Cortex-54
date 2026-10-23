// CORTEX-54 web terminal (Phase 6, ADR-034). Vanilla JS, no build step. Every value from the API is rendered
// with textContent (never innerHTML), so journal/news text can't inject markup.

const $ = (sel) => document.querySelector(sel);
const POLL_MS = 15_000;
let tab = "deck";
let timer = null;

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k instanceof Node ? k : String(k));
  return n;
}
const usd = (x) => (x === null || x === undefined ? "—" : `$${Number(x).toFixed(2)}`);
const ago = (ms) => (ms ? `${Math.max(0, Math.round((Date.now() - ms) / 1000))}s ago` : "never");
const when = (ms) => `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)}Z`;
const parse = (s, d = {}) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : (s ?? d);
  } catch {
    return d;
  }
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.add("hidden"), 6000);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (r.status === 401) {
    signedOut(true);
    throw new Error("signed out");
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || body.error || `HTTP ${r.status}`);
  return body;
}

async function command(name, args = {}) {
  try {
    const r = await api("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cortex-web": "1" },
      body: JSON.stringify({ name, ...args }),
    });
    toast(r.message);
  } catch (e) {
    toast(`⚠️ ${e.message}`);
  }
  refresh();
}

function signedOut(on) {
  $("#signin").classList.toggle("hidden", !on);
  for (const s of document.querySelectorAll(".tab")) s.classList.toggle("hidden", on || s.id !== tab);
}

// ---------------------------------------------------------------- Command Deck

function sparkline(points) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 300 90");
  svg.setAttribute("preserveAspectRatio", "none");
  if (!points || points.length < 2) return svg;
  const ys = points.map((p) => p[1]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${((i / (points.length - 1)) * 300).toFixed(1)},${(85 - ((p[1] - lo) / span) * 80).toFixed(1)}`,
    )
    .join(" ");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#38bdf8");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);
  return svg;
}

function accountCard(a, equity) {
  const stopSel = el(
    "select",
    { "aria-label": "Dial stop" },
    ...[0, 1, 2, 3, 4].map((n) => el("option", { value: n }, `Stop ${n}`)),
  );
  stopSel.value = String(a.autonomyStop);
  const ratify = el("input", { placeholder: "RATIFY (LIVE only)", size: 16, "aria-label": "Ratify" });
  const pm = el("textarea", {
    placeholder: "Postmortem (required to unlock after RED)",
    "aria-label": "Postmortem",
  });
  const positions = a.positions.length
    ? el(
        "div",
        { class: "scroll" },
        el(
          "table",
          {},
          el(
            "tr",
            {},
            el("th", {}, "Symbol"),
            el("th", {}, "Qty"),
            el("th", {}, "Entry"),
            el("th", {}, "Stop"),
            el("th", {}, "Target"),
          ),
          ...a.positions.map((p) =>
            el(
              "tr",
              {},
              el("td", {}, p.symbol),
              el("td", { class: "mono" }, p.qty),
              el("td", { class: "mono" }, p.avgEntry),
              el("td", { class: "mono" }, `${p.stop}${p.brokerStop ? " 🛡" : " ⚠️"}`),
              el("td", { class: "mono" }, p.target),
            ),
          ),
        ),
      )
    : el("p", { class: "muted" }, "flat");
  return el(
    "div",
    { class: "card" },
    el(
      "h2",
      {},
      `${a.account} · ${a.rung} · Stop ${a.autonomyStop} `,
      el("span", { class: `pill ${a.breaker}` }, a.breaker),
      a.locked ? " 🔒" : "",
    ),
    a.configured ? null : el("p", { class: "muted" }, "not configured"),
    el(
      "dl",
      { class: "kv" },
      el("dt", {}, "Equity"),
      el(
        "dd",
        {},
        usd(a.equityUsd),
        a.account === "PAPER"
          ? el(
              "span",
              { class: "muted" },
              ` (broker ${usd(a.brokerEquityUsd)}, modeled costs ${usd(a.modeledCostUsd)})`,
            )
          : null,
      ),
      el("dt", {}, "HWM"),
      el("dd", {}, usd(a.hwmUsd)),
      el("dt", {}, "Mode"),
      el("dd", {}, a.mode, a.modeReason ? el("span", { class: "muted" }, ` (${a.modeReason})`) : null),
      el("dt", {}, "Orders today"),
      el("dd", {}, a.ordersToday),
    ),
    sparkline(equity),
    el("h3", {}, `Positions (${a.positions.length})`),
    positions,
    el(
      "div",
      { class: "controls" },
      el("button", { class: "btn", onclick: () => command("pause", { account: a.account }) }, "Pause"),
      el("button", { class: "btn", onclick: () => command("resume", { account: a.account }) }, "Resume"),
      stopSel,
      a.account === "LIVE" ? ratify : null,
      el(
        "button",
        {
          class: "btn",
          onclick: () =>
            command("dial", {
              account: a.account,
              stop: Number(stopSel.value),
              confirm: ratify.value.trim(),
            }),
        },
        "Set dial",
      ),
      el(
        "button",
        {
          class: "btn danger",
          onclick: () => {
            if (confirm(`FLATTEN ALL on ${a.account}? This sells every position at market.`))
              command("flatten", { account: a.account });
          },
        },
        "Flatten",
      ),
    ),
    a.locked
      ? el(
          "div",
          { class: "controls" },
          pm,
          el(
            "button",
            { class: "btn", onclick: () => command("unlock", { account: a.account, postmortem: pm.value }) },
            "Unlock",
          ),
        )
      : null,
  );
}

async function renderDeck() {
  const s = await api("/api/state");
  $("#pulse").textContent =
    `pulse ${ago(s.lastPulseAt)} · budget ${s.budget.mode} · journal #${s.journalHead.seq}`;
  const sym = el("input", { placeholder: "BTC/USD or NVDA", size: 14, "aria-label": "Symbol" });
  const regimes = el(
    "div",
    { class: "card" },
    el("h2", {}, "Regime"),
    el(
      "div",
      { class: "scroll" },
      el(
        "table",
        {},
        el(
          "tr",
          {},
          el("th", {}, "Arena"),
          el("th", {}, "Posture"),
          el("th", {}, "Score"),
          el("th", {}, "Age"),
        ),
        ...s.regimes.map((r) =>
          el(
            "tr",
            {},
            el("td", {}, r.arena),
            el("td", {}, r.posture),
            el("td", {}, r.score === null ? "—" : Number(r.score).toFixed(0)),
            el("td", {}, `${r.ageMinutes}m${r.fresh ? "" : " ⚠️ stale"}`),
          ),
        ),
      ),
    ),
    el("h3", {}, "Convene the court"),
    el(
      "div",
      { class: "controls" },
      sym,
      el(
        "button",
        { class: "btn", onclick: () => sym.value.trim() && command("court", { symbol: sym.value.trim() }) },
        "Convene",
      ),
    ),
  );
  $("#deck").replaceChildren(
    el("div", { class: "grid" }, ...s.accounts.map((a) => accountCard(a, s.equity?.[a.account])), regimes),
  );
}

// ---------------------------------------------------------------- Court

async function renderCourt() {
  const [sessions, rejections] = await Promise.all([api("/api/court"), api("/api/rejections")]);
  $("#court").replaceChildren(
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Court sessions"),
      sessions.length === 0 ? el("p", { class: "muted" }, "no sessions yet") : null,
      ...sessions.map((c) => {
        const p = parse(c.payload_json);
        const models = parse(c.models_used, []);
        return el(
          "div",
          { class: "card" },
          el("h3", {}, `${p.symbol ?? c.symbol ?? "?"} · ${when(c.ts)}`),
          el(
            "p",
            {},
            `win ${p.win_raw ?? "—"} → calibrated ${p.win_cal ?? "—"} · bear lethality ${p.bear ?? "—"} · conviction ${c.proposed_conviction ?? "—"}`,
          ),
          c.thesis_summary ? el("p", {}, el("strong", {}, "Bull: "), c.thesis_summary) : null,
          c.bear_case_brief ? el("p", {}, el("strong", {}, "Bear: "), c.bear_case_brief) : null,
          el("p", { class: "muted" }, models.map((m) => `${m.role} ${m.provider}/${m.model}`).join(" · ")),
        );
      }),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Recent rejections"),
      el(
        "div",
        { class: "scroll" },
        el(
          "table",
          {},
          el(
            "tr",
            {},
            el("th", {}, "When"),
            el("th", {}, "Stage"),
            el("th", {}, "Symbol"),
            el("th", {}, "Reasons"),
          ),
          ...rejections.map((r) =>
            el(
              "tr",
              {},
              el("td", { class: "mono" }, when(r.ts)),
              el("td", {}, r.stage),
              el("td", {}, r.symbol),
              el("td", {}, parse(r.reason_codes, []).join("; ")),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- Memory Vault

async function renderMemory() {
  const m = await api("/api/memory");
  const rep = Object.entries(m.reputation || {});
  const report = m.report ? parse(m.report.payload_json) : null;
  $("#memory").replaceChildren(
    el(
      "div",
      { class: "grid" },
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Scar tissue"),
        m.scars.length === 0 ? el("p", { class: "muted" }, "no merged rules") : null,
        ...m.scars.map((r) =>
          el(
            "p",
            {},
            el("strong", {}, `${r.id} `),
            el("span", { class: "muted" }, `${r.kind}${r.expires ? ` · until ${r.expires}` : ""} — `),
            r.rule,
          ),
        ),
      ),
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Source reputation (W_rep)"),
        rep.length === 0 ? el("p", { class: "muted" }, "no scored sources yet") : null,
        ...rep.map(([k, v]) =>
          el("p", {}, el("span", { class: "mono" }, k), ` · weight ${v.weight} · ${v.signals} signals`),
        ),
      ),
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Beliefs"),
        m.beliefs.length === 0 ? el("p", { class: "muted" }, "none yet") : null,
        ...m.beliefs.map((b) =>
          el("p", {}, b.statement, el("span", { class: "muted" }, ` (${b.confidence})`)),
        ),
      ),
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Latest Governor report"),
        report?.card
          ? el(
              "div",
              {},
              el("p", { class: "muted" }, report.card.title),
              ...report.card.sections.map((s) =>
                el("div", {}, el("h3", {}, s.name), el("p", { class: "mono" }, s.value)),
              ),
            )
          : el("p", { class: "muted" }, "no report yet"),
      ),
    ),
  );
}

// ---------------------------------------------------------------- Options Lab

async function renderOptions() {
  const rows = await api("/api/options");
  $("#options").replaceChildren(
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Options shadow ledger (virtual, never sent to a broker)"),
      rows.length === 0 ? el("p", { class: "muted" }, "no shadow trades yet") : null,
      el(
        "div",
        { class: "scroll" },
        el(
          "table",
          {},
          el(
            "tr",
            {},
            el("th", {}, "When"),
            el("th", {}, "Event"),
            el("th", {}, "Strategy"),
            el("th", {}, "Underlying"),
            el("th", {}, "Max loss"),
            el("th", {}, "P&L / R"),
          ),
          ...rows.map((r) =>
            el(
              "tr",
              {},
              el("td", { class: "mono" }, when(r.ts)),
              el("td", {}, r.kind === "CLOSE" ? `CLOSE ${r.reason ?? ""}` : "OPEN"),
              el("td", {}, String(r.strategy).replace("OPTIONS_", "")),
              el("td", {}, r.underlying),
              el("td", { class: "mono" }, usd(r.max_loss_cents / 100)),
              el("td", { class: "mono" }, r.pnl_cents === null ? "—" : `${usd(r.pnl_cents / 100)} · ${r.r}R`),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- shell

const RENDER = { deck: renderDeck, court: renderCourt, memory: renderMemory, options: renderOptions };

async function refresh() {
  try {
    await RENDER[tab]();
    signedOut(false);
  } catch (e) {
    if (e.message !== "signed out") toast(`⚠️ ${e.message}`);
  }
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => document.visibilityState === "visible" && tab === "deck" && refresh(), POLL_MS);
}

for (const b of document.querySelectorAll("#tabs button")) {
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    for (const x of document.querySelectorAll("#tabs button")) x.classList.toggle("on", x === b);
    for (const s of document.querySelectorAll(".tab")) s.classList.toggle("hidden", s.id !== tab);
    refresh();
  });
}

async function boot() {
  const m = location.hash.match(/^#login=([\w.-]+)$/);
  if (m) {
    history.replaceState(null, "", location.pathname); // drop the one-time token from the address bar
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: m[1] }),
    });
    if (!r.ok) toast("⚠️ That link has expired or was already used. Run /terminal again.");
  }
  await refresh();
  schedule();
}
boot();
