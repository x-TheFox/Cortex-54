import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { type LocalConfig, LocalConfigSchema } from "./config.ts";

/**
 * Encrypted backups (ADR-076, MLP4-031 + the §E settings export). One file holds everything needed to carry on from
 * another computer: settings (keys only when the user asks), the hot state, the journal and applied memory packs.
 * Always encrypted with a passphrase (scrypt → AES-256-GCM), because even without keys the journal is private.
 * Restoring keeps this computer's generated local secrets (sessions, ingest, tray) and never touches a running brain:
 * the caller stops it, swaps the files in, and starts it again.
 */

const MAGIC = "cortex-54-backup";
const FILES = ["hot.sqlite", "journal.sqlite", "scar-tissue.local.json"] as const;
type FileName = (typeof FILES)[number];

const EnvelopeSchema = z.object({
  kind: z.literal(MAGIC),
  v: z.literal(1),
  made_at: z.string(),
  with_keys: z.boolean(),
  kdf: z.object({
    name: z.literal("scrypt"),
    n: z.number().int(),
    r: z.number().int(),
    p: z.number().int(),
    salt: z.string(),
  }),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

const ContentsSchema = z.object({
  config: z.unknown(),
  files: z.record(z.string(), z.string()),
});

const KDF = { n: 2 ** 15, r: 8, p: 1 };
const key = (pass: string, salt: Buffer, k = KDF) =>
  scryptSync(pass.normalize("NFKC"), salt, 32, { N: k.n, r: k.r, p: k.p, maxmem: 128 * k.n * k.r * 2 });

/** A consistent copy of a live SQLite database (WAL included) without stopping it. */
export function snapshotDb(db: DatabaseSync): Buffer {
  const dir = join(tmpdir(), `cortex54-snap-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, "snap.sqlite");
  try {
    db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
    return readFileSync(f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function makeBackup(o: {
  cfg: LocalConfig;
  includeKeys: boolean;
  passphrase: string;
  files: Partial<Record<FileName, Buffer>>;
  now?: Date;
}): string {
  if (o.passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const cfg: LocalConfig = o.includeKeys
    ? o.cfg
    : {
        ...o.cfg,
        keys: {},
        llm: { ...o.cfg.llm, endpoints: o.cfg.llm.endpoints.map((e) => ({ ...e, key: "" })) },
      };
  const contents = {
    config: { ...cfg, cloud: o.includeKeys ? cfg.cloud : undefined },
    files: Object.fromEntries(
      Object.entries(o.files)
        .filter(([, b]) => b && b.length)
        .map(([n, b]) => [n, (b as Buffer).toString("base64")]),
    ),
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(o.passphrase, salt), iv);
  const data = Buffer.concat([c.update(gzipSync(JSON.stringify(contents))), c.final()]);
  return JSON.stringify({
    kind: MAGIC,
    v: 1,
    made_at: (o.now ?? new Date()).toISOString(),
    with_keys: o.includeKeys,
    kdf: { name: "scrypt", ...KDF, salt: salt.toString("base64") },
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}

export interface OpenedBackup {
  madeAt: string;
  withKeys: boolean;
  config: LocalConfig;
  files: Partial<Record<FileName, Buffer>>;
}

export function openBackup(text: string, passphrase: string): OpenedBackup {
  let env: z.infer<typeof EnvelopeSchema>;
  try {
    env = EnvelopeSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("This isn't a Savant backup file.");
  }
  if (env.kdf.n > 2 ** 20 || env.kdf.r > 32 || env.kdf.p > 16)
    throw new Error("Backup settings out of range.");
  let plain: Buffer;
  try {
    const d = createDecipheriv(
      "aes-256-gcm",
      key(passphrase, Buffer.from(env.kdf.salt, "base64"), env.kdf),
      Buffer.from(env.iv, "base64"),
    );
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    plain = Buffer.concat([d.update(Buffer.from(env.data, "base64")), d.final()]);
  } catch {
    throw new Error("Wrong passphrase (or the file was changed).");
  }
  const c = ContentsSchema.parse(JSON.parse(gunzipSync(plain).toString("utf8")));
  const files: Partial<Record<FileName, Buffer>> = {};
  for (const [n, b] of Object.entries(c.files))
    if ((FILES as readonly string[]).includes(n)) files[n as FileName] = Buffer.from(b, "base64");
  return { madeAt: env.made_at, withKeys: env.with_keys, config: LocalConfigSchema.parse(c.config), files };
}

/**
 * Write a backup into a Savant home (the brain must be stopped). This computer keeps its own generated secrets, port
 * and network setting; keys come from the backup when it has them, else the ones already here stay.
 */
export function restoreInto(home: string, b: OpenedBackup, current: LocalConfig | null): LocalConfig {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // audit F-A6-06: stage every file first, then swap; if any swap fails, put the previous files back, so a failed
  // restore never leaves a mix of old and new databases
  const names = Object.keys(b.files);
  for (const n of names) writeFileSync(join(home, `${n}.restore`), b.files[n as FileName] as Buffer, { mode: 0o600 });
  const swapped: string[] = [];
  try {
    for (const n of names) {
      const dest = join(home, n);
      if (existsSync(dest)) renameSync(dest, `${dest}.prev`);
      for (const side of ["-wal", "-shm"]) rmSync(`${dest}${side}`, { force: true });
      renameSync(`${dest}.restore`, dest);
      swapped.push(dest);
    }
  } catch (e) {
    for (const dest of swapped) rmSync(dest, { force: true });
    for (const n of names) {
      const dest = join(home, n);
      if (existsSync(`${dest}.prev`)) renameSync(`${dest}.prev`, dest);
      rmSync(`${dest}.restore`, { force: true });
    }
    throw e;
  }
  for (const n of names) rmSync(join(home, `${n}.prev`), { force: true });
  return restoredConfig(b, current);
}

/** The settings a restore ends up with (pure): see restoreInto. */
export function restoredConfig(b: OpenedBackup, current: LocalConfig | null): LocalConfig {
  const cfg: LocalConfig = {
    ...b.config,
    secrets: current?.secrets ?? b.config.secrets,
    port: current?.port ?? b.config.port,
    bind: current?.bind ?? b.config.bind,
    lan: current?.lan ?? b.config.lan,
    secret_store: current?.secret_store ?? "file",
    keys: b.withKeys ? b.config.keys : (current?.keys ?? {}),
    llm: b.withKeys
      ? b.config.llm
      : {
          ...b.config.llm,
          // audit F-A6-06: a key stays with the address it was given to; a backup that repoints an endpoint id at
          // another URL gets no key
          endpoints: b.config.llm.endpoints.map((e) => {
            const mine = current?.llm.endpoints.find((x) => x.id === e.id);
            return { ...e, key: mine && mine.url === e.url ? mine.key : "" };
          }),
        },
    onboarded: true,
  };
  // a paper backup without its Alpaca keys can't start in paper mode: start in demo, the journal is all there
  if (cfg.mode === "paper" && !(cfg.keys.ALPACA_PAPER_KEY_ID && cfg.keys.ALPACA_PAPER_SECRET))
    return { ...cfg, mode: "demo" };
  return cfg;
}

export const backupFileName = (d = new Date()) => `cortex54-backup-${d.toISOString().slice(0, 10)}.c54backup`;

export function homeFiles(home: string): FileName[] {
  return FILES.filter((f) => existsSync(join(home, f)));
}
