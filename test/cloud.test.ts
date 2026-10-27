import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyKeys, newConfig } from "../local/config.ts";
import { brainConfig, brainSecrets, deploy, type Runner, stripJsonc } from "../local/deploy.ts";
import { claimOnce } from "../local/runner.ts";
import { HOT_SCHEMA } from "../src/cortex/hot-schema.ts";
import { QueueDispatcher } from "../src/cortex/queue.ts";
import { verifySignedBody } from "../src/lib/hmac.ts";
import { memorySql } from "./sim/sqlite.ts";

describe("job queue for desktop runners (ADR-065)", () => {
  it("one unclaimed job per key, oldest first, stale claims released, old jobs expire", async () => {
    const sql = memorySql();
    for (const s of HOT_SCHEMA) sql.exec(s);
    let now = 1_000_000_000;
    const q = new QueueDispatcher(sql, () => now, 3_600_000);
    await q.dispatch("research.yml", { job: "world" });
    await q.dispatch("research.yml", { job: "world" });
    await q.dispatch("research.yml", { job: "dossier", symbol: "NVDA", mode: "case" });
    await q.dispatch("governor.yml", { weekly: "false" });
    expect(q.depth()).toBe(3);
    expect(q.claim("mac")?.inputs).toEqual({ job: "world" });
    expect(q.claim("mac")?.inputs.symbol).toBe("NVDA");
    await q.dispatch("research.yml", { job: "world" }); // the claimed one doesn't block a new run
    expect(q.depth()).toBe(2);
    now += 2 * 3_600_000; // the dossier claim went stale
    const again = [q.claim("pc"), q.claim("pc"), q.claim("pc"), q.claim("pc")].map(
      (j) => j?.inputs.job ?? j?.workflow ?? null,
    );
    expect(again).toContain("dossier");
    now += 25 * 3_600_000;
    await q.dispatch("research.yml", { job: "kronos" });
    expect(q.claim("pc")?.inputs.job).toBe("kronos"); // older unrun jobs expired
  });

  it("runner claim is HMAC-signed and hands the job to the local job runner", async () => {
    const secret = "s".repeat(40);
    const dispatched: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const ok = await verifySignedBody(
        secret,
        new Headers(init?.headers).get("x-cortex-signature"),
        new Headers(init?.headers).get("x-cortex-timestamp"),
        String(init?.body),
      );
      expect(url).toBe("https://cortex.example.workers.dev/runner/claim");
      return ok
        ? Response.json({ job: { workflow: "research.yml", inputs: { job: "dossier", symbol: "SOL/USD" } } })
        : new Response("bad", { status: 401 });
    }) as typeof fetch;
    const got = await claimOnce(
      "https://cortex.example.workers.dev/",
      secret,
      { dispatch: async (w, i) => void dispatched.push(`${w}:${i.symbol}`) },
      fetcher,
      "test",
    );
    expect(got).toBe("research.yml dossier SOL/USD");
    expect(dispatched).toEqual(["research.yml:SOL/USD"]);
    await expect(
      claimOnce(
        "https://cortex.example.workers.dev",
        "wrong".repeat(8),
        { dispatch: async () => undefined },
        fetcher,
      ),
    ).rejects.toThrow(/401/);
  });
});

describe("cortex deploy (ADR-065)", () => {
  const root = process.cwd();
  it("parses the repo's JSONC (URLs inside strings survive) and writes a customer config with no operator ids", () => {
    const tpl = readFileSync("wrangler.jsonc", "utf8");
    expect(JSON.parse(stripJsonc(tpl)).vars.DISCORD_CHANNELS).toContain("command_center");
    const c = JSON.parse(brainConfig(tpl, { name: "acme", journal: "j-id", lab: "l-id", kv: "kv-id" }));
    expect(c.name).toBe("acme");
    expect(
      c.d1_databases.map(
        (d: { database_name: string; database_id: string }) => `${d.database_name}=${d.database_id}`,
      ),
    ).toEqual(["acme-journal=j-id", "acme-lab=l-id"]);
    expect(c.kv_namespaces).toEqual([{ binding: "FLAGS", id: "kv-id" }]);
    expect(c.assets).toEqual({ directory: "public", binding: "ASSETS" });
    expect(c.vars).toEqual({
      CORTEX_ENV: "production",
      CORTEX_DO_NAME: "CORTEX-54-PRIMARY",
      CORTEX_LAB_DO_NAME: "CORTEX-54-LAB",
      RUNNER_MODE: "queue",
    });
    expect(JSON.stringify(c)).not.toMatch(/x-TheFox|samplayz2ks|c041a668|1562933931324477455/);
  });

  it("creates what's missing, migrates, deploys, uploads secrets via a temp file it deletes", () => {
    const home = mkdtempSync(join(tmpdir(), "c54-deploy-"));
    const cfg = applyKeys(newConfig("paper"), [
      "CLOUDFLARE_ACCOUNT_ID=acct",
      "CLOUDFLARE_API_TOKEN=tok",
      "GROQ_API_KEY=g",
      "ALPACA_PAPER_KEY_ID=k",
      "ALPACA_PAPER_SECRET=s",
    ]);
    const calls: string[] = [];
    let d1: { name: string; uuid: string }[] = [];
    let kv: { id: string; title: string }[] = [];
    const secretsSeen: Record<string, string>[] = [];
    const run: Runner = (_cmd, a, env) => {
      const args = a.slice(2);
      calls.push(args.slice(0, 3).join(" "));
      expect(env).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" });
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "d1" && args[1] === "list") return ok(JSON.stringify(d1));
      if (args[0] === "d1" && args[1] === "create") {
        d1 = [...d1, { name: args[2] as string, uuid: `uuid-${args[2]}` }];
        return ok();
      }
      if (args[0] === "kv" && args[2] === "list") return ok(JSON.stringify(kv));
      if (args[0] === "kv" && args[2] === "create") {
        kv = [{ id: "kv1", title: args[3] as string }];
        return ok();
      }
      if (args[0] === "secret") {
        secretsSeen.push(JSON.parse(readFileSync(args[2] as string, "utf8")));
        return ok();
      }
      if (args[0] === "deploy")
        return ok(
          args[2]?.includes("sentinel")
            ? "https://acme-sentinel.me.workers.dev"
            : "Deployed https://acme.me.workers.dev (1.2s)",
        );
      return ok();
    };
    const r = deploy({ root, home, cfg, name: "acme", run });
    expect(r.url).toBe("https://acme.me.workers.dev");
    expect(r.sentinelUrl).toBe("https://acme-sentinel.me.workers.dev");
    expect(r.d1).toEqual({ journal: "uuid-acme-journal", lab: "uuid-acme-lab" });
    expect(calls.filter((c) => c.startsWith("d1 create"))).toHaveLength(2);
    expect(calls).toContain("d1 migrations apply");
    expect(secretsSeen[0]).toMatchObject({
      GROQ_API_KEY: "g",
      ALPACA_PAPER_KEY_ID: "k",
      INGEST_HMAC_SECRET: r.cloud.ingest_hmac,
      PILL_TOKEN: cfg.secrets.pill_token,
    });
    expect(secretsSeen[0]).not.toHaveProperty("CLOUDFLARE_API_TOKEN"); // the deploy token never goes into the worker
    expect(secretsSeen[1]).toHaveProperty("SENTINEL_TICK_SECRET");
    // second run: nothing new is created
    calls.length = 0;
    deploy({ root, home, cfg: { ...cfg, cloud: r.cloud }, name: "acme", run });
    expect(calls.filter((c) => c.includes("create"))).toEqual([]);
  });

  it("refuses without Cloudflare credentials or with a bad name", () => {
    const home = mkdtempSync(join(tmpdir(), "c54-deploy-"));
    const run: Runner = () => ({ status: 0, stdout: "", stderr: "" });
    expect(() => deploy({ root, home, cfg: newConfig("demo"), name: "x", run })).toThrow(
      /CLOUDFLARE_ACCOUNT_ID/,
    );
    const cfg = applyKeys(newConfig("demo"), ["CLOUDFLARE_ACCOUNT_ID=a", "CLOUDFLARE_API_TOKEN=t"]);
    expect(() => deploy({ root, home, cfg, name: "Bad Name", run })).toThrow(/lowercase/);
    expect(brainSecrets(cfg, "i".repeat(40))).not.toHaveProperty("CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("deploy verification (MLP0-015 for customers' clouds)", () => {
  it("passes when the new constitution answers; rolls back when it never does", async () => {
    const { verifyDeploy } = await import("../local/deploy.ts");
    const { newConfig } = await import("../local/config.ts");
    const cfg = { ...newConfig("demo"), keys: { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" } };
    const ran: string[][] = [];
    const run = (_c: string, a: string[]) => {
      ran.push(a);
      return { status: 0, stdout: "", stderr: "" };
    };
    let sha = "old";
    const fetcher = async () => Response.json({ constitution_sha256: sha });
    const sleep = async () => {
      sha = "new";
    };
    const ok = await verifyDeploy({
      url: "https://x.workers.dev",
      name: "acme",
      cfg,
      expectConstitution: "new",
      run,
      fetcher,
      sleep,
    });
    expect(ok).toEqual({ healthy: true, rolledBack: false, detail: "the new brain is answering" });
    expect(ran).toEqual([]);
    const bad = await verifyDeploy({
      url: "https://x.workers.dev",
      name: "acme",
      cfg,
      expectConstitution: "never",
      run,
      fetcher: async () => new Response("boom", { status: 500 }),
      sleep: async () => undefined,
      tries: 2,
    });
    expect(bad).toMatchObject({ healthy: false, rolledBack: true });
    expect(ran[0]).toEqual(expect.arrayContaining(["rollback", "--name", "acme", "-y"]));
  });
});
