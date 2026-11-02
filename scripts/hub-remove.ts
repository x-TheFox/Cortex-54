/**
 * Audit HUB-01: hide a hub agent (and its packs) or a single pack, e.g. after a removal request or a report.
 * Operator only: runs `wrangler d1 execute` against the hub's database.
 *
 *   pnpm hub:remove <agent_id|pack_id> [--restore] [--local]
 *   pnpm hub:remove --reports            list the latest reports
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const remote = args.includes("--local") ? "--local" : "--remote";
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
      remote,
      "-c",
      "hub/wrangler.jsonc",
      "--command",
      q,
    ],
    { stdio: "inherit" },
  );

if (args.includes("--reports")) {
  sql("SELECT target, reason, datetime(at/1000, 'unixepoch') AS at FROM reports ORDER BY at DESC LIMIT 50");
} else {
  const id = args.find((a) => /^[0-9a-f]{16}$/.test(a));
  if (!id) {
    console.error("usage: pnpm hub:remove <agent_id|pack_id> [--restore] [--local] | --reports");
    process.exit(1);
  }
  const v = args.includes("--restore") ? 0 : 1;
  sql(
    `UPDATE agents SET hidden = ${v} WHERE agent_id = '${id}'; UPDATE packs SET hidden = ${v} WHERE pack_id = '${id}' OR agent_id = '${id}';`,
  );
  console.log(`${v ? "Hidden" : "Restored"}: ${id}`);
}
