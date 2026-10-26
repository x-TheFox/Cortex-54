import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SqlLike } from "../src/cortex/store.ts";
import {
  agentIdOf,
  type Pack,
  PackSchema,
  publicKeyOf,
  signPayload,
  unsigned,
  verifyPayload,
} from "../src/hub/protocol.ts";
import { sha256Hex } from "../src/lib/sha256.ts";
import { ScarRuleSchema, type ScarTissue, ScarTissueSchema } from "../src/risk/scar.ts";

/**
 * Memory packs (ADR-068; operator ask "memory uploading", dossier MLP3-010 / MLP4-023). An agent's learned memory —
 * scar rules (vetoes earned from ≥ 3 postmortems) and beliefs — exported as a signed pack, shared on the hub, and
 * imported by another agent. Importing only stages a proposal; nothing changes how the agent trades until the
 * operator runs `cortex memory apply` (constitution U8: self-modification needs the operator). Scar rules can only
 * remove trades, so an applied pack can make an agent more careful, never more aggressive.
 */

const BeliefItem = z.object({
  subject: z.string().min(1).max(40),
  statement: z.string().min(5).max(300),
  c0: z.number().min(0).max(1),
  half_life_days: z.number().positive().max(365),
});
export const MemoryContent = z.object({
  scar_rules: z.array(ScarRuleSchema).max(50).default([]),
  beliefs: z.array(BeliefItem).max(200).default([]),
});

export const localScarPath = (home: string) => join(home, "scar-tissue.local.json");

export function loadLocalScar(home: string): ScarTissue {
  const p = localScarPath(home);
  if (!existsSync(p)) return { version: 1, rules: [] };
  return ScarTissueSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

/** The repo's merged scar tissue plus what this operator applied locally (ids stay unique). */
export function mergeScar(base: ScarTissue, local: ScarTissue): ScarTissue {
  const ids = new Set(base.rules.map((r) => r.id));
  return { version: base.version, rules: [...base.rules, ...local.rules.filter((r) => !ids.has(r.id))] };
}

export async function exportPack(
  sql: SqlLike,
  scar: ScarTissue,
  privateKey: string,
  title: string,
  description: string,
  now: number,
): Promise<Pack> {
  const beliefs = sql
    .exec<{ subject: string; statement: string; c0: number; half_life_days: number }>(
      "SELECT subject, statement, c0, half_life_days FROM beliefs WHERE status != 'ARCHIVED' LIMIT 200",
    )
    .map((b) => ({ subject: b.subject, statement: b.statement, c0: b.c0, half_life_days: b.half_life_days }));
  const body: Omit<Pack, "sig"> = {
    v: 1,
    kind: "memory",
    title,
    description,
    public_key: await publicKeyOf(privateKey),
    created_at: now,
    content: MemoryContent.parse({ scar_rules: scar.rules, beliefs }),
  };
  return { ...body, sig: await signPayload(privateKey, body) };
}

/** Verify a pack and stage it under proposals/. Returns the proposal id and a summary. */
export async function stagePack(
  home: string,
  raw: unknown,
): Promise<{ id: string; author: string; rules: number; beliefs: number }> {
  const pack = PackSchema.parse(raw);
  if (pack.kind !== "memory") throw new Error(`not a memory pack (${pack.kind})`);
  if (!(await verifyPayload(pack.public_key, unsigned(pack), pack.sig)))
    throw new Error("pack signature does not verify");
  const content = MemoryContent.parse(pack.content);
  const id = sha256Hex(JSON.stringify(pack)).slice(0, 16);
  mkdirSync(join(home, "proposals"), { recursive: true });
  writeFileSync(join(home, "proposals", `${id}.json`), JSON.stringify({ pack, content }, null, 2), {
    mode: 0o600,
  });
  return {
    id,
    author: agentIdOf(pack.public_key),
    rules: content.scar_rules.length,
    beliefs: content.beliefs.length,
  };
}

/** Operator approval: merge a staged pack into this agent's memory. Imported beliefs start at half confidence. */
export function applyPack(
  home: string,
  sql: SqlLike,
  id: string,
  now: number,
): { rules: number; beliefs: number } {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("bad proposal id");
  const p = join(home, "proposals", `${id}.json`);
  if (!existsSync(p)) throw new Error(`no staged pack ${id}`);
  const { pack, content } = JSON.parse(readFileSync(p, "utf8")) as {
    pack: Pack;
    content: z.infer<typeof MemoryContent>;
  };
  const author = agentIdOf(pack.public_key);
  const local = loadLocalScar(home);
  let next = 9000 + local.rules.length;
  const taken = new Set(local.rules.map((r) => r.rule));
  const tagged = (rule: string) => `${rule} [pack ${id} from ${author}]`.slice(0, 300);
  const added = content.scar_rules
    .filter((r) => !taken.has(tagged(r.rule)))
    .map((r) => ({
      ...r,
      id: `SCAR-${next++}`,
      rule: `${r.rule} [pack ${id} from ${author}]`.slice(0, 300),
    }));
  writeFileSync(
    localScarPath(home),
    JSON.stringify(ScarTissueSchema.parse({ version: 1, rules: [...local.rules, ...added] }), null, 2),
  );
  for (const b of content.beliefs)
    sql.exec(
      `INSERT OR IGNORE INTO beliefs (belief_id, subject, statement, c0, half_life_days, validated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      `pack-${id}-${sha256Hex(b.statement).slice(0, 8)}`,
      b.subject,
      `${b.statement} (from agent ${author})`.slice(0, 300),
      b.c0 * 0.5,
      b.half_life_days,
      now,
    );
  return { rules: added.length, beliefs: content.beliefs.length };
}
