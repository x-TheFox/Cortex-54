/**
 * ADR-102: the operator's side of the impact pledge. Savant (the company) makes each month's gifts itself, then
 * records them here so getsavant.pro/impact shows the receipt next to the pledged amount. Nothing here moves money.
 *
 *   pnpm impact months                                   the published months and their allocations
 *   pnpm impact paid <YYYY-MM> <suggestion id> <amount USD> <receipt https URL>
 *   pnpm impact reject <suggestion id>                   not a registered nonprofit (it drops out of the ranking)
 *   pnpm impact list                                     the suggestions, most supported first
 * Add --local to run against the local D1.
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2).filter((a) => a !== "--local");
const where = process.argv.includes("--local") ? "--local" : "--remote";
const sql = (q: string) =>
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "node_modules/wrangler/bin/wrangler.js",
      "d1",
      "execute",
      "savant-hub",
      where,
      "-c",
      "hub/wrangler.jsonc",
      "--command",
      q,
    ],
    { stdio: "inherit" },
  );
const fail = (m: string) => {
  console.error(m);
  process.exit(1);
};
const [cmd, ...rest] = args;
if (cmd === "months")
  sql(
    "SELECT m.month, m.net_cents/100.0 AS net_usd, m.pool_cents/100.0 AS pool_usd, a.suggestion_id, a.name, a.amount_cents/100.0 AS pledged, a.paid_cents/100.0 AS paid, a.receipt_url FROM impact_months m LEFT JOIN impact_allocations a ON a.month = m.month WHERE m.status = 'published' ORDER BY m.month DESC",
  );
else if (cmd === "list")
  sql(
    "SELECT id, name, url, votes, status FROM impact_suggestions ORDER BY votes DESC, created_at LIMIT 100",
  );
else if (cmd === "reject") {
  const id = Number(rest[0]);
  if (!Number.isInteger(id) || id <= 0) fail("usage: pnpm impact reject <suggestion id>");
  sql(`UPDATE impact_suggestions SET status = 'rejected' WHERE id = ${id}`);
} else if (cmd === "paid") {
  const [month, sid, usd, receipt] = rest;
  if (!/^\d{4}-\d{2}$/.test(month ?? "")) fail("month must be YYYY-MM");
  const id = Number(sid);
  const cents = Math.round(Number(usd) * 100);
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(cents) || cents <= 0)
    fail("give a suggestion id and an amount in USD");
  if (!/^https:\/\/[^\s'"]{4,300}$/.test(receipt ?? "")) fail("the receipt must be an https URL");
  sql(
    `UPDATE impact_allocations SET paid_cents = ${cents}, receipt_url = '${receipt}', paid_at = ${Date.now()} WHERE month = '${month}' AND suggestion_id = ${id}`,
  );
} else
  fail("usage: pnpm impact months | list | reject <id> | paid <YYYY-MM> <id> <usd> <receipt-url> [--local]");
