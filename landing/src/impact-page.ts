import "./plain.ts";
import { h } from "./auth.ts";

/**
 * getsavant.pro/impact (ADR-102): the 20% pledge, live. Reads the hub's /v1/impact through the site's /hub rewrite.
 * Built like a public ledger: the month's running numbers first, then the method, the community's list and every
 * past month with its receipts. Nothing on this page asks anyone for money.
 */

interface Month {
  month: string;
  gross_cents: number;
  refunds_cents: number;
  net_cents: number;
  pool_cents: number;
  slots: number;
  charges: number;
  status: string;
  computed_at: number | null;
  published_at?: number | null;
  days_left?: number;
  allocations?: {
    name: string;
    url: string | null;
    amount_cents: number;
    paid_cents: number | null;
    receipt_url: string | null;
    paid_at: number | null;
    votes: number;
  }[];
}
interface Suggestion {
  id: number;
  name: string;
  url: string | null;
  reason: string;
  votes: number;
  leading: boolean;
}
interface View {
  share: number;
  slot_target_cents: number;
  max_slots: number;
  current: Month;
  suggestions: Suggestion[];
  months: Month[];
  totals: { pledged_cents: number; paid_cents: number };
}

const root = document.querySelector("[data-root]") as HTMLElement;
const usd = (c: number) =>
  `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const host = (u: string | null) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

async function get(): Promise<View | null> {
  try {
    const r = await fetch("/hub/v1/impact", { cache: "no-store" });
    return r.ok ? ((await r.json()) as View) : null;
  } catch {
    return null;
  }
}
async function post(path: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetch(`/hub/v1/impact/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as { ok?: boolean; message?: string };
    return { ok: Boolean(j.ok), message: j.message ?? (r.ok ? "Done." : "That didn't work. Try again.") };
  } catch {
    return { ok: false, message: "The impact service isn't answering. Try again in a minute." };
  }
}

function tracker(v: View): HTMLElement {
  const c = v.current;
  const pool = c.pool_cents;
  const next = Math.min(v.max_slots, Math.max(1, c.slots + (pool > 0 ? 1 : 0)));
  const target = next * v.slot_target_cents;
  const pct = Math.max(2, Math.min(100, Math.round((pool / Math.max(1, target)) * 100)));
  // CSP allows styles set through the CSSOM, not style attributes
  const fill = h("span", {});
  fill.style.width = `${pct}%`;
  return h(
    "section",
    { class: "imp-tracker", "aria-labelledby": "imp-now" },
    h("p", { class: "kicker", id: "imp-now" }, `${monthName(c.month)} · live`),
    h(
      "dl",
      { class: "imp-figs" },
      h("div", {}, h("dt", {}, "Revenue this month"), h("dd", {}, usd(c.net_cents))),
      h(
        "div",
        {},
        h("dt", {}, `${Math.round(v.share * 100)}% pledged`),
        h("dd", { class: "imp-pool" }, usd(pool)),
      ),
      h("div", {}, h("dt", {}, "Foundations funded"), h("dd", {}, String(c.slots))),
      h(
        "div",
        {},
        h("dt", {}, "Month closes in"),
        h("dd", {}, `${c.days_left ?? "—"} day${c.days_left === 1 ? "" : "s"}`),
      ),
    ),
    h(
      "div",
      {
        class: "imp-bar",
        role: "img",
        "aria-label": `${usd(pool)} of ${usd(target)} toward ${next} foundation${next === 1 ? "" : "s"}`,
      },
      fill,
    ),
    h(
      "p",
      { class: "fine" },
      c.slots >= v.max_slots
        ? `The pool funds the maximum of ${v.max_slots} foundations this month.`
        : `Every ${usd(v.slot_target_cents)} in the pool funds one more foundation (up to ${v.max_slots}). ${usd(Math.max(0, target - pool))} to go for foundation ${next}.`,
      c.computed_at
        ? ` Updated ${new Date(c.computed_at).toLocaleString()}.`
        : " First update after the next daily refresh.",
    ),
  );
}

function suggestForm(refresh: (flash?: { m: string; ok: boolean }) => void): HTMLElement {
  const msg = h("p", { class: "acct-note", role: "status", hidden: "" });
  const name = h("input", {
    class: "imp-input",
    name: "name",
    required: "",
    maxlength: "120",
    autocomplete: "off",
  }) as HTMLInputElement;
  const url = h("input", {
    class: "imp-input",
    name: "url",
    required: "",
    maxlength: "300",
    inputmode: "url",
    placeholder: "example.org",
  }) as HTMLInputElement;
  const why = h("textarea", {
    class: "imp-input",
    name: "reason",
    maxlength: "400",
    rows: "3",
  }) as HTMLTextAreaElement;
  const form = h(
    "form",
    { class: "imp-form", novalidate: "" },
    h("label", {}, h("span", {}, "Foundation or charity"), name),
    h("label", {}, h("span", {}, "Its website"), url),
    h("label", { class: "imp-wide" }, h("span", {}, "Why (optional)"), why),
    h("p", { class: "imp-wide" }, h("button", { class: "btn btn-ink", type: "submit" }, "Suggest it")),
    msg,
  ) as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await post("suggest", { name: name.value, url: url.value, reason: why.value });
    msg.textContent = r.message;
    msg.className = `acct-note imp-wide ${r.ok ? "acct-ok" : "acct-warn"}`;
    msg.hidden = false;
    if (r.ok) refresh({ m: r.message, ok: true });
  });
  return form;
}

function suggestions(
  v: View,
  refresh: (flash?: { m: string; ok: boolean }) => void,
  note: (m: string, ok: boolean) => void,
): HTMLElement {
  if (v.suggestions.length === 0)
    return h(
      "p",
      { class: "acct-note" },
      "No suggestions yet. Be the first: the foundations with the most support are funded each month.",
    );
  return h(
    "ol",
    { class: "imp-list" },
    ...v.suggestions.map((s) => {
      const b = h("button", { class: "btn btn-line btn-sm", type: "button" }, "Support");
      b.addEventListener("click", async () => {
        const r = await post("vote", { id: s.id });
        if (r.ok) refresh({ m: r.message, ok: true });
        else note(r.message, false);
      });
      return h(
        "li",
        { class: s.leading ? "imp-lead" : "" },
        h(
          "div",
          { class: "imp-who" },
          h("b", {}, s.name),
          s.url ? h("a", { href: s.url, rel: "noopener nofollow ugc" }, host(s.url)) : "",
          s.leading ? h("span", { class: "imp-tag" }, "Funded if the month closed now") : "",
          s.reason ? h("p", { class: "fine" }, s.reason) : "",
        ),
        h(
          "span",
          { class: "imp-votes" },
          h("b", {}, String(s.votes)),
          s.votes === 1 ? " supporter" : " supporters",
        ),
        b,
      );
    }),
  );
}

function report(m: Month): HTMLElement {
  const given = (m.allocations ?? []).reduce((a, x) => a + (x.paid_cents ?? 0), 0);
  return h(
    "article",
    { class: "imp-month" },
    h("h3", {}, monthName(m.month)),
    h(
      "p",
      { class: "comm-stats" },
      h("span", {}, h("b", {}, usd(m.gross_cents)), " collected"),
      h("span", {}, h("b", {}, usd(m.refunds_cents)), " refunded"),
      h("span", {}, h("b", {}, usd(m.pool_cents)), " pledged (20%)"),
      h("span", {}, h("b", {}, usd(given)), " given so far"),
    ),
    (m.allocations ?? []).length
      ? h(
          "div",
          { class: "comm-scroll" },
          h(
            "table",
            { class: "comm-table" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                ...["Foundation", "Supporters", "Pledged", "Given", "Receipt"].map((t) =>
                  h("th", { scope: "col" }, t),
                ),
              ),
            ),
            h(
              "tbody",
              {},
              ...(m.allocations ?? []).map((a) =>
                h(
                  "tr",
                  {},
                  h("td", {}, a.url ? h("a", { href: a.url, rel: "noopener nofollow" }, a.name) : a.name),
                  h("td", {}, String(a.votes)),
                  h("td", {}, usd(a.amount_cents)),
                  h("td", {}, a.paid_cents ? usd(a.paid_cents) : h("span", { class: "fine" }, "In progress")),
                  h(
                    "td",
                    {},
                    a.receipt_url ? h("a", { href: a.receipt_url, rel: "noopener" }, "Receipt") : "—",
                  ),
                ),
              ),
            ),
          ),
        )
      : h(
          "p",
          { class: "fine" },
          m.pool_cents > 0
            ? "No eligible suggestions this month; the pool carries into the record as pledged."
            : "No revenue this month, so no pool.",
        ),
  );
}

async function render(flash?: { m: string; ok: boolean }): Promise<void> {
  const v = await get();
  if (!v) {
    root.replaceChildren(
      h("p", { class: "kicker" }, "Impact"),
      h("h1", { class: "welcome-title" }, "A fifth of everything we earn goes where you say."),
      h(
        "p",
        { class: "acct-note acct-warn" },
        "The live numbers aren't loading right now. Try again in a minute.",
      ),
    );
    return;
  }
  const banner = h("p", { class: "acct-note", role: "status", hidden: "" });
  const note = (m: string, ok: boolean) => {
    banner.textContent = m;
    banner.className = `acct-note ${ok ? "acct-ok" : "acct-warn"}`;
    banner.hidden = false;
  };
  const refresh = (f?: { m: string; ok: boolean }) => void render(f);
  root.replaceChildren(
    h("p", { class: "kicker" }, "Impact"),
    h("h1", { class: "welcome-title" }, "A fifth of everything we earn goes where you say."),
    h(
      "p",
      { class: "lede" },
      `Every month, Savant gives ${Math.round(v.share * 100)}% of its gross revenue to foundations the community suggests. It's our pledge, paid from our own revenue: we never ask you to donate, and we never hold anyone's money.`,
    ),
    tracker(v),
    h(
      "p",
      { class: "comm-stats" },
      h("span", {}, h("b", {}, usd(v.totals.pledged_cents)), " pledged since the start"),
      h("span", {}, h("b", {}, usd(v.totals.paid_cents)), " given, with receipts"),
    ),
    h("h2", {}, "How it works"),
    h(
      "ol",
      { class: "comm-steps imp-steps" },
      h(
        "li",
        {},
        h("b", {}, "Suggest. "),
        "Anyone can suggest a registered nonprofit. The same foundation suggested twice is merged automatically.",
      ),
      h(
        "li",
        {},
        h("b", {}, "Support. "),
        "Back up to 10 foundations a month. Support carries over from month to month.",
      ),
      h(
        "li",
        {},
        h("b", {}, "Count. "),
        `On the 1st, the month's revenue is final: ${Math.round(v.share * 100)}% of it is the pool, and every ${usd(v.slot_target_cents)} funds one foundation (up to ${v.max_slots}).`,
      ),
      h(
        "li",
        {},
        h("b", {}, "Give. "),
        "The most-supported foundations split the pool equally. A foundation that wins sits out 3 months so the pool reaches more causes. Each gift's receipt is posted here.",
      ),
    ),
    h("h2", { id: "suggest" }, "Suggest a foundation"),
    suggestForm(refresh),
    banner,
    h("h2", {}, "The community's list"),
    suggestions(v, refresh, note),
    h("h2", {}, "Monthly reports"),
    ...(v.months.length
      ? v.months.map(report)
      : [h("p", { class: "fine" }, "The first report is published when this month closes.")]),
    h("h2", {}, "The fine print"),
    h(
      "ul",
      { class: "plain-list fine imp-fine" },
      h(
        "li",
        {},
        "Gross revenue means every subscription charge Savant collected in the calendar month (UTC), before payment-processor fees, minus refunds issued that month. It comes straight from the payment processor.",
      ),
      h(
        "li",
        {},
        "This is a pledge by Savant, from Savant's own revenue. Savant doesn't take donations, doesn't pass anyone else's money on, and doesn't hold funds for anyone. Gifts are made by Savant directly to each foundation.",
      ),
      h(
        "li",
        {},
        "Eligible: registered nonprofits and charities that can receive a gift from a company. A suggestion that isn't eligible is taken off the list and the next one is funded instead.",
      ),
      h(
        "li",
        {},
        "Published reports are a permanent record: amounts never change after a month closes; only receipts are added.",
      ),
      h(
        "li",
        {},
        "Supporting a foundation doesn't cost anything and needs no account. Savant doesn't give tax advice; the company's gifts don't create a deduction for you.",
      ),
    ),
  );
  if (flash) {
    note(flash.m, flash.ok);
    banner.scrollIntoView({ block: "center" });
  }
}

void render();
