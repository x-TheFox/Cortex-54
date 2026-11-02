import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * OS keychain for the user's keys (ADR-076, was MLP3-012 "key-signing proxy"). The desktop app turns it on by itself
 * the first time it starts (audit SEC-02, `autoKeychain`); `secret_store: "keychain"` in config.json moves every API key out of the file into the system's own secret store, and config.json keeps only
 * generated local secrets (session, ingest, tray pill). Backends use the tools the OS ships, so no native module:
 *   macOS   – `security` (login Keychain, generic password), value passed on stdin, never in argv
 *   Linux   – `secret-tool` (libsecret / GNOME Keyring / KWallet), value on stdin
 *   Windows – DPAPI (CurrentUser) through PowerShell, a ciphertext file in the Savant home only this user can open
 * The headless image keeps the file (no desktop session to unlock a keychain).
 */

export interface SecretBackend {
  readonly name: string;
  available(): boolean;
  get(account: string): string | null;
  set(account: string, value: string): void;
  del(account: string): void;
}

const SERVICE = "savant";
/** audit POL-03: the pre-rebrand service name, still read so nobody's keys go missing; the next save moves them */
const LEGACY_SERVICE = "cortex54";

/** One keychain item per Savant home, so a demo home or a second profile never reads the main one's keys. */
export const accountFor = (home: string) =>
  `keys-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`;

const run = (cmd: string, args: string[], input?: string, env?: Record<string, string>) =>
  spawnSync(cmd, args, {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15_000,
    windowsHide: true,
  });

const has = (cmd: string) => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0;
};

export function macKeychain(keychain?: string): SecretBackend {
  const kc = keychain ? [keychain] : [];
  return {
    name: "macOS Keychain",
    available: () => process.platform === "darwin" && has("security"),
    get(account) {
      let r = run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w", ...kc]);
      if (r.status !== 0)
        r = run("security", ["find-generic-password", "-s", LEGACY_SERVICE, "-a", account, "-w", ...kc]);
      if (r.status !== 0) return null;
      return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
    },
    set(account, value) {
      // `security -i` reads the command from stdin, so the value never shows up in a process list; base64 keeps it
      // free of quotes and spaces for security's own command parser
      const b64 = Buffer.from(value, "utf8").toString("base64");
      const line = `add-generic-password -U -s ${SERVICE} -a ${account} -l "Savant keys" -w ${b64}${kc.length ? ` ${kc[0]}` : ""}\n`;
      const r = run("security", ["-i"], line);
      if (r.status !== 0 || /error|fail/i.test(r.stderr ?? ""))
        throw new Error(`Keychain refused the keys: ${(r.stderr || r.stdout || "").trim().slice(0, 160)}`);
      if (this.get(account) !== value) throw new Error("Keychain did not keep the keys (read-back mismatch)");
      run("security", ["delete-generic-password", "-s", LEGACY_SERVICE, "-a", account, ...kc]);
    },
    del(account) {
      run("security", ["delete-generic-password", "-s", SERVICE, "-a", account, ...kc]);
      run("security", ["delete-generic-password", "-s", LEGACY_SERVICE, "-a", account, ...kc]);
    },
  };
}

export function secretTool(): SecretBackend {
  return {
    name: "system keyring (libsecret)",
    available: () => process.platform === "linux" && has("secret-tool"),
    get(account) {
      for (const svc of [SERVICE, LEGACY_SERVICE]) {
        const r = run("secret-tool", ["lookup", "service", svc, "account", account]);
        if (r.status === 0 && r.stdout) return r.stdout;
      }
      return null;
    },
    set(account, value) {
      const r = run(
        "secret-tool",
        ["store", "--label=Savant keys", "service", SERVICE, "account", account],
        value,
      );
      if (r.status !== 0)
        throw new Error(`Keyring refused the keys: ${(r.stderr ?? "").trim().slice(0, 160)}`);
      run("secret-tool", ["clear", "service", LEGACY_SERVICE, "account", account]);
    },
    del(account) {
      for (const svc of [SERVICE, LEGACY_SERVICE])
        run("secret-tool", ["clear", "service", svc, "account", account]);
    },
  };
}

export function dpapi(home: string): SecretBackend {
  const file = (account: string) => join(home, `${account}.dpapi`);
  const ps = (script: string, input: string | undefined, f: string) =>
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Security; ${script}`],
      input,
      { CORTEX_DPAPI_FILE: f },
    );
  return {
    name: "Windows Data Protection (DPAPI)",
    available: () => process.platform === "win32",
    get(account) {
      if (!existsSync(file(account))) return null;
      const r = ps(
        "$b=[IO.File]::ReadAllBytes($env:CORTEX_DPAPI_FILE); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($p))",
        undefined,
        file(account),
      );
      return r.status === 0 ? Buffer.from(r.stdout.trim(), "base64").toString("utf8") : null;
    },
    set(account, value) {
      const r = ps(
        "$in=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $b=[Security.Cryptography.ProtectedData]::Protect($in,$null,'CurrentUser'); [IO.File]::WriteAllBytes($env:CORTEX_DPAPI_FILE,$b)",
        Buffer.from(value, "utf8").toString("base64"),
        file(account),
      );
      if (r.status !== 0) throw new Error(`DPAPI refused the keys: ${(r.stderr ?? "").trim().slice(0, 160)}`);
    },
    del(account) {
      rmSync(file(account), { force: true });
    },
  };
}

/** In-memory backend (tests). */
export function memoryBackend(): SecretBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    name: "memory",
    store,
    available: () => true,
    get: (a) => store.get(a) ?? null,
    set: (a, v) => {
      store.set(a, v);
    },
    del: (a) => {
      store.delete(a);
    },
  };
}

let override: SecretBackend | null = null;
/** tests: swap the backend */
export function setSecretBackend(b: SecretBackend | null): void {
  override = b;
}

export function secretBackend(home: string): SecretBackend {
  if (override) return override;
  if (process.platform === "darwin") return macKeychain(process.env.CORTEX_KEYCHAIN || undefined);
  if (process.platform === "win32") return dpapi(home);
  return secretTool();
}

/**
 * Audit SEC-02: on the desktop app, keys live in the system keychain by default. Run once per home: a computer whose
 * keychain works is switched over (the file keeps no keys); one without a working keychain keeps the file. Either way
 * the choice is recorded, so a user who switches back to the file in Settings stays there.
 */
export function shouldAutoKeychain(cfg: {
  secret_store: string;
  secret_store_chosen?: boolean | undefined;
}): boolean {
  return cfg.secret_store === "file" && cfg.secret_store_chosen !== true;
}
