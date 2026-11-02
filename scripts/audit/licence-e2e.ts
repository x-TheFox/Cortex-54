/**
 * Pre-release audit: the app's licence lifecycle end to end against scripts/audit/whop-standin.ts.
 *
 *   pnpm exec tsx scripts/audit/licence-e2e.ts start   # prints the device code + the URL to open in a browser
 *   pnpm exec tsx scripts/audit/licence-e2e.ts finish  # polls, activates, then runs the lifecycle scenarios
 *
 * Uses the app's own functions (local/license.ts) with the licence server at :8791 and the stand-in's public key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  activateKey,
  entriesBlocked,
  pollDeviceSignIn,
  readLicense,
  refreshLicense,
  startDeviceSignIn,
} from "../../local/license.ts";

const server = "http://127.0.0.1:8791";
const whop = "http://127.0.0.1:8790";
const home = process.env.LIC_HOME ?? "docs/audit/runs/lic-home";
const pubkey = readFileSync("docs/audit/runs/licence-pubkey.txt", "utf8").trim();
const state = `${home}/device.json`;
mkdirSync(home, { recursive: true });
const admin = (b: unknown) =>
  fetch(`${whop}/admin/membership`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
const out: Record<string, unknown> = {};

if (process.argv[2] === "start") {
  const r = await startDeviceSignIn(home, { server });
  writeFileSync(state, JSON.stringify(r));
  console.log(JSON.stringify({ ok: r.ok, code: r.ok ? r.code : null, url: r.ok ? r.url : null }));
} else {
  const d = JSON.parse(readFileSync(state, "utf8")) as { secret: string };
  const poll = await pollDeviceSignIn(d.secret, { server });
  out.poll = poll.status;
  if (poll.status !== "approved" || !poll.key) {
    console.log(JSON.stringify(out));
    process.exit(1);
  }
  const key = poll.key;
  const a = await activateKey(home, key, { server, pubkey });
  out.activate = { ok: a.ok, message: a.message };
  const st = readLicense(home, pubkey);
  out.after_activate = { ok: st.required && st.ok, blocked: entriesBlocked(st) };

  // 1. fresh token: a refresh inside 24 h does not even ask the server (so a refund is not seen yet)
  await admin({ id: "mem_trial1", status: "canceled" });
  out.refund_then_refresh_now = await refreshLicense(home, key, { server, pubkey });
  out.refund_entries_blocked_now = entriesBlocked(readLicense(home, pubkey));
  // 2. a day later the app asks, learns the refund, and drops the token
  out.refund_then_refresh_25h = await refreshLicense(home, key, {
    server,
    pubkey,
    now: Date.now() + 25 * 3_600_000,
  });
  out.refund_entries_blocked_25h = entriesBlocked(readLicense(home, pubkey));

  // 3. reactivate (undo refund) → past_due (Whop's retry grace) still works
  await admin({ id: "mem_trial1", status: "past_due" });
  const b = await activateKey(home, key, { server, pubkey });
  out.past_due_activate = b.ok;

  // 4. clock rollback: a token far past expiry looks valid when the clock is set back
  const lic = JSON.parse(readFileSync(`${home}/license.json`, "utf8")) as { expires_at: string };
  const realNow = Date.now();
  const afterExpiry = Date.parse(lic.expires_at) + 30 * 86_400_000;
  const { checkLicense } = await import("../../local/license.ts");
  out.clock_forward_30d_valid =
    (
      checkLicense(JSON.parse(readFileSync(`${home}/license.json`, "utf8")), pubkey, afterExpiry) as {
        ok?: boolean;
      }
    ).ok === true;
  out.clock_rolled_back_valid =
    (
      checkLicense(JSON.parse(readFileSync(`${home}/license.json`, "utf8")), pubkey, realNow) as {
        ok?: boolean;
      }
    ).ok === true;
  out.refresh_with_clock_rolled_back = await refreshLicense(home, key, { server, pubkey, now: realNow });

  // 5. edited token: change the plan / expiry → signature must fail
  const t = JSON.parse(readFileSync(`${home}/license.json`, "utf8")) as Record<string, unknown>;
  out.edited_token_valid =
    (checkLicense({ ...t, expires_at: "2099-01-01T00:00:00.000Z" }, pubkey) as { ok?: boolean }).ok === true;
  // 6. copied to another machine: the machine id in the token no longer matches
  out.copied_token_valid_elsewhere =
    (checkLicense(t, pubkey, Date.now(), "f".repeat(40)) as { ok?: boolean }).ok === true;
  // 7. second machine with the same key
  const other = await fetch(`${server}/v1/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, machine: "b".repeat(40) }),
  }).then((r) => r.json() as Promise<{ code?: string }>);
  out.second_machine = other.code ?? "activated";
  // 8. a spoofed machine id equal to the bound one (VM clone / copied fingerprint): accepted by design
  const bound = (
    (await fetch(`${whop}/admin/state`).then((r) => r.json())) as {
      memberships: Record<string, { metadata: { hwid?: string } }>;
    }
  ).memberships.mem_trial1?.metadata.hwid;
  const spoof = await fetch(`${server}/v1/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, machine: bound }),
  }).then((r) => r.json() as Promise<{ ok?: boolean }>);
  out.spoofed_machine_id_accepted = spoof.ok === true;
  if (existsSync(state)) writeFileSync(`${home}/result.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
