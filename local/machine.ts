import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stable, private machine fingerprint for licence binding (ADR-086). It is the sha256 of the OS's own machine id
 * (macOS IOPlatformUUID, Windows MachineGuid, Linux machine-id) with a Savant prefix, so the raw hardware id never
 * leaves the computer and can't be matched against other apps. When the OS gives nothing, a random id is kept in the
 * Savant home instead (it then moves with a restored backup, which is acceptable: the server still binds one machine).
 */
export function machineId(home: string, platform = process.platform): string {
  const k = `${platform}:${home}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const raw = osMachineId(platform) ?? homeMachineId(home);
  const id = createHash("sha256").update(`savant-machine:${raw}`).digest("hex").slice(0, 40);
  cache.set(k, id); // read every pulse (licence check): ask the OS once per process
  return id;
}
const cache = new Map<string, string>();

function osMachineId(platform: string): string | null {
  try {
    if (platform === "darwin") {
      const r = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(r.stdout ?? "")?.[1] ?? null;
    }
    if (platform === "win32") {
      const r = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(r.stdout ?? "")?.[1] ?? null;
    }
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"])
      if (existsSync(p)) {
        const v = readFileSync(p, "utf8").trim();
        if (v) return v;
      }
  } catch {
    /* fall through */
  }
  return null;
}

function homeMachineId(home: string): string {
  const p = join(home, "machine-id");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const v = randomBytes(16).toString("hex");
  writeFileSync(p, `${v}\n`, { mode: 0o600 });
  return v;
}
