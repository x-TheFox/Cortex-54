import { labelDownloads } from "./downloads.ts";
import "./plain.ts";
import { api, finishSignIn, h, signedIn, signIn, signOut } from "./auth.ts";

/**
 * getsavant.pro/account (ADR-093): the customer's plans, computers, licence key and billing, signed in with Whop.
 * Cancelling and undoing it, and removing a computer, happen right here; payment methods and invoices open Whop.
 */
interface Plan {
  id: string;
  plan: string;
  paid: boolean;
  status: string;
  trial: boolean;
  renews_at: string | null;
  cancel_at_period_end: boolean;
  manage_url: string | null;
  license_key: string | null;
  device: { name: string; activated_at: string | null; last_seen: string | null } | null;
}

const root = document.querySelector("[data-root]") as HTMLElement;
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "—";
const ago = (iso: string | null) => {
  if (!iso) return "not yet";
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  return h < 1 ? "within the hour" : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

function btn(label: string, cls: string, on: () => void | Promise<void>): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${cls}` }, label) as HTMLButtonElement;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await on();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function signedOut(msg?: string): void {
  root.replaceChildren(
    h("p", { class: "kicker" }, "Your account"),
    h("h1", { class: "welcome-title" }, "Sign in to Savant."),
    h(
      "p",
      { class: "lede" },
      "Use the Whop account you bought Savant with. Your plan, your computers, your licence and your billing are all here.",
    ),
    ...(msg ? [h("p", { class: "acct-note acct-warn", role: "alert" }, msg)] : []),
    h(
      "p",
      { class: "dl" },
      btn("Sign in with Whop", "btn-ink btn-lg", () => signIn()),
    ),
    h(
      "p",
      { class: "fine" },
      "New here? ",
      h("a", { href: "/#pricing" }, "Start the 7-day free trial"),
      " first. Checkout creates your Whop account.",
    ),
  );
}

function planCard(p: Plan, note: (m: string, ok: boolean) => void, reload: () => void): HTMLElement {
  const status = !p.paid
    ? "Free demo · no licence needed"
    : p.cancel_at_period_end
      ? `Cancelled · active until ${day(p.renews_at)}`
      : p.trial
        ? `Free trial · first charge on ${day(p.renews_at)}`
        : ["active", "completed"].includes(p.status)
          ? `Active · renews ${day(p.renews_at)}`
          : p.status === "past_due"
            ? "Payment failed · update your payment method in Manage billing"
            : `Ended (${p.status})`;
  const act = async (path: string, ok: string) => {
    const r = await api(path, { membership: p.id });
    note(r.ok ? String(r.message ?? ok) : String(r.message ?? "That didn't work. Try again."), r.ok);
    if (r.ok) reload();
  };
  const card = h(
    "article",
    { class: "plan acct-plan" },
    h("p", { class: "plan-name" }, p.plan),
    h("p", { class: "acct-status" }, status),
  );
  if (p.paid) {
    card.append(
      h("h3", {}, "Computer"),
      p.device
        ? h(
            "div",
            { class: "acct-device" },
            h(
              "p",
              {},
              h("b", {}, p.device.name),
              ` · signed in ${day(p.device.activated_at)} · last check ${ago(p.device.last_seen)}`,
            ),
            btn("Remove this computer", "btn-line btn-sm", () =>
              confirm(
                `Remove ${p.device?.name}? It stops opening new trades at its next check; open positions keep their stops.`,
              )
                ? act("/v1/account/deactivate", "Removed.")
                : undefined,
            ),
          )
        : h(
            "p",
            {},
            "No computer yet. In Savant: Settings → Licence → ",
            h("b", {}, "Sign in with your Savant account"),
            ".",
          ),
    );
    if (p.license_key) {
      const key = h("code", { class: "acct-key" }, "•••• •••• •••• ••••");
      card.append(
        h("h3", {}, "Licence key"),
        h(
          "p",
          { class: "fine" },
          "Only needed for a computer without a browser. Signing in from the app is easier.",
        ),
        h(
          "p",
          { class: "acct-keyrow" },
          key,
          btn("Show", "btn-line btn-sm", () => {
            key.textContent = p.license_key;
          }),
          btn("Copy", "btn-line btn-sm", async () => {
            await navigator.clipboard?.writeText(p.license_key ?? "");
            note("Licence key copied.", true);
          }),
        ),
      );
    }
    const actions = h("p", { class: "dl" });
    if (["active", "trialing", "past_due"].includes(p.status))
      actions.append(
        p.cancel_at_period_end
          ? btn("Keep my subscription", "btn-ink", () => act("/v1/account/undo-cancel", "Kept."))
          : btn("Cancel subscription", "btn-line", () =>
              confirm(
                p.trial
                  ? "Cancel your trial? You won't be charged, and Savant goes back to demo mode when the trial ends."
                  : `Cancel? You keep everything until ${day(p.renews_at)} and won't be charged again.`,
              )
                ? act("/v1/account/cancel", "Cancelled.")
                : undefined,
            ),
      );
    if (p.manage_url)
      actions.append(
        h("a", { class: "btn btn-line", href: p.manage_url, rel: "noopener" }, "Manage billing and invoices"),
      );
    card.append(actions);
  }
  return card;
}

async function show(): Promise<void> {
  const r = await api("/v1/account");
  if (r.status === 401) return signedOut("Your sign-in expired. Sign in again.");
  if (!r.ok) {
    root.replaceChildren(
      h("p", { class: "acct-note acct-warn" }, String(r.message ?? "Couldn't load your account.")),
    );
    return;
  }
  const user = r.user as { name: string | null; email: string | null };
  const plans = (r.plans as Plan[]).sort((a, b) => Number(b.paid) - Number(a.paid));
  const banner = h("p", { class: "acct-note", role: "status", hidden: "" });
  const note = (m: string, ok: boolean) => {
    banner.textContent = m;
    banner.className = `acct-note ${ok ? "acct-ok" : "acct-warn"}`;
    banner.hidden = false;
  };
  const paid = plans.filter((p) => p.paid);
  root.replaceChildren(
    h("p", { class: "kicker" }, "Your account"),
    h("h1", { class: "welcome-title" }, user.name ? `Hello, ${user.name}.` : "Your account"),
    ...(user.email ? [h("p", { class: "fine" }, `Signed in with Whop as ${user.email}`)] : []),
    banner,
    ...(paid.length === 0
      ? [
          h(
            "p",
            { class: "acct-note" },
            "No Savant plan on this Whop account yet. The demo works without one; paper and live trading need a plan. ",
            h("a", { href: "/#pricing" }, "Start the 7-day free trial →"),
          ),
        ]
      : []),
    h("div", { class: "acct-grid" }, ...plans.map((p) => planCard(p, note, () => void show()))),
    h("h2", {}, "Download ", h("span", { class: "fine", "data-dl-version": "" })),
    h(
      "p",
      { class: "dl" },
      h("a", { class: "btn btn-line", href: "/download/mac" }, "macOS · Apple silicon"),
      h("a", { class: "btn btn-line", href: "/download/mac-intel" }, "macOS · Intel"),
      h("a", { class: "btn btn-line", href: "/download/windows" }, "Windows"),
      h("a", { class: "btn btn-line", href: "/download/linux" }, "Linux"),
    ),
    h(
      "p",
      { class: "fine" },
      h("a", { href: "/docs/install/" }, "Install guide"),
      " (including the one-time macOS and Windows security prompts) · ",
      h("a", { href: "/docs/" }, "All docs"),
    ),
    h(
      "p",
      { class: "dl" },
      btn("Sign out", "btn-line btn-sm", async () => {
        await signOut();
        signedOut();
      }),
    ),
  );
  void labelDownloads(root);
}

(async () => {
  try {
    await finishSignIn();
  } catch (e) {
    return signedOut((e as Error).message);
  }
  if (!signedIn()) return signedOut();
  await show();
})();
