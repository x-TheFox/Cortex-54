import "./plain.ts";
import { api, finishSignIn, h, signedIn, signIn } from "./auth.ts";

/**
 * getsavant.pro/activate?code=XXXX-XXXX (ADR-093): the browser half of the app's device sign-in. The visitor signs in
 * with Whop, checks the code matches the one in the app, and approves; a licence on another computer moves only when
 * they say so.
 */
const root = document.querySelector("[data-root]") as HTMLElement;
const msg = (t: string, cls = "") => h("p", { class: `acct-note ${cls}`, role: "status" }, t);
const valid = (c: string) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c);

function frame(...kids: (Node | string)[]): void {
  root.replaceChildren(h("p", { class: "kicker" }, "Sign in this computer"), ...kids);
}

function btn(label: string, cls: string, on: () => Promise<void>): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${cls}` }, label) as HTMLButtonElement;
  b.addEventListener("click", async () => {
    b.disabled = true;
    await on();
    b.disabled = false;
  });
  return b;
}

async function approve(code: string, move = false): Promise<void> {
  const r = await api("/v1/device/approve", { code, move });
  if (r.ok)
    return frame(
      h("h1", { class: "welcome-title" }, "Done. Go back to Savant."),
      msg(String(r.message), "acct-ok"),
      h("p", { class: "fine" }, "You can close this tab. ", h("a", { href: "/account/" }, "Your account →")),
    );
  if (r.code === "bound_elsewhere")
    return frame(
      h("h1", { class: "welcome-title" }, `Move Savant from ${String(r.elsewhere)}?`),
      h(
        "p",
        { class: "lede" },
        `Your licence works on one computer at a time. Moving it here means ${String(r.elsewhere)} stops opening new trades at its next check (its open positions keep their stops).`,
      ),
      h(
        "p",
        { class: "dl" },
        btn("Move it to this computer", "btn-ink btn-lg", () => approve(code, true)),
        h("a", { class: "btn btn-line btn-lg", href: "/account/" }, "Not now"),
      ),
    );
  if (r.status === 401) return signIn({ code });
  frame(
    h(
      "h1",
      { class: "welcome-title" },
      r.code === "no_subscription" ? "No plan on this account yet." : "That didn't work.",
    ),
    msg(String(r.message ?? "Try again from the Savant app."), "acct-warn"),
    ...(r.code === "no_subscription"
      ? [
          h(
            "p",
            { class: "dl" },
            h("a", { class: "btn btn-ink btn-lg", href: "/#pricing" }, "Start the 7-day free trial"),
          ),
        ]
      : []),
  );
}

async function show(code: string): Promise<void> {
  const r = await api(`/v1/device/info?code=${encodeURIComponent(code)}`);
  if (r.status === 401) return signIn({ code });
  if (!r.ok) return approve(code); // same messages (expired, no plan)
  frame(
    h("h1", { class: "welcome-title" }, `Sign in Savant on ${String(r.device)}?`),
    h("p", { class: "lede" }, "Check that this code matches the one in the Savant app:"),
    h("p", { class: "acct-code" }, code),
    h("p", { class: "fine" }, `Plan: ${String(r.plan)}`),
    h(
      "p",
      { class: "dl" },
      btn("Sign in this computer", "btn-ink btn-lg", () => approve(code)),
    ),
    h("p", { class: "fine" }, "Didn't start this from the Savant app? Close this page."),
  );
}

(async () => {
  let kept: Record<string, string> | null = null;
  try {
    kept = await finishSignIn();
  } catch (e) {
    return frame(msg((e as Error).message, "acct-warn"));
  }
  const code = (kept?.code ?? new URLSearchParams(location.search).get("code") ?? "").toUpperCase().trim();
  if (!valid(code))
    return frame(
      h("h1", { class: "welcome-title" }, "Start from the Savant app."),
      h(
        "p",
        { class: "lede" },
        "In Savant, open Settings → Licence and click Sign in with your Savant account. It opens this page with your code.",
      ),
    );
  if (!signedIn())
    return frame(
      h("h1", { class: "welcome-title" }, "Sign in to connect this computer."),
      h("p", { class: "lede" }, "Use the Whop account you bought Savant with."),
      h("p", { class: "acct-code" }, code),
      h(
        "p",
        { class: "dl" },
        btn("Sign in with Whop", "btn-ink btn-lg", () => signIn({ code })),
      ),
    );
  await show(code);
})();
