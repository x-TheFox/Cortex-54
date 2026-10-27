import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Background runner (ADR-064): start cortexd at login and restart it if it dies. launchd on macOS, a systemd user
 * unit on Linux, Task Scheduler on Windows. No admin rights anywhere. `plan` is pure (tested); `install` writes it.
 */

export interface ServicePlan {
  platform: NodeJS.Platform;
  file: string | null;
  content: string | null;
  enable: string[][];
  disable: string[][];
}

const LABEL = "com.cortex54.daemon";
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plan(
  platform: NodeJS.Platform,
  argv: string[],
  env: { CORTEX_HOME: string },
  home = homedir(),
): ServicePlan {
  if (platform === "darwin") {
    const file = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>CORTEX_HOME</key><string>${xml(env.CORTEX_HOME)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(join(env.CORTEX_HOME, "logs", "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(env.CORTEX_HOME, "logs", "daemon.log"))}</string>
</dict>
</plist>
`;
    return {
      platform,
      file,
      content,
      enable: [["launchctl", "load", "-w", file]],
      disable: [["launchctl", "unload", "-w", file]],
    };
  }
  if (platform === "linux") {
    const file = join(home, ".config", "systemd", "user", "cortex54.service");
    const q = (a: string) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    const content = `[Unit]
Description=Savant trading agent (local mode)
After=network-online.target

[Service]
Environment=CORTEX_HOME=${env.CORTEX_HOME}
ExecStart=${argv.map(q).join(" ")}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
    return {
      platform,
      file,
      content,
      enable: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "cortex54.service"],
      ],
      disable: [["systemctl", "--user", "disable", "--now", "cortex54.service"]],
    };
  }
  if (platform === "win32") {
    const cmd = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    return {
      platform,
      file: null,
      content: null,
      enable: [
        [
          "schtasks",
          "/Create",
          "/F",
          "/SC",
          "ONLOGON",
          "/RL",
          "LIMITED",
          "/TN",
          "CORTEX54",
          "/TR",
          // audit F-A6-05: `set "VAR=value"` keeps a home path with spaces (C:\Users\Jane Doe\…) whole
          `cmd /c set "CORTEX_HOME=${env.CORTEX_HOME}" && ${cmd}`,
        ],
      ],
      disable: [["schtasks", "/Delete", "/F", "/TN", "CORTEX54"]],
    };
  }
  throw new Error(`no background service support for ${platform}`);
}

export function install(p: ServicePlan): string[] {
  const done: string[] = [];
  if (p.file && p.content) {
    mkdirSync(dirname(p.file), { recursive: true });
    writeFileSync(p.file, p.content);
    done.push(`wrote ${p.file}`);
  }
  for (const c of p.enable) {
    const r = spawnSync(c[0] as string, c.slice(1), { stdio: "pipe" });
    done.push(
      `${c.join(" ")} → ${r.status === 0 ? "ok" : `exit ${r.status}: ${String(r.stderr).slice(0, 160)}`}`,
    );
  }
  return done;
}

export function uninstall(p: ServicePlan): string[] {
  const done: string[] = [];
  for (const c of p.disable) {
    const r = spawnSync(c[0] as string, c.slice(1), { stdio: "pipe" });
    done.push(`${c.join(" ")} → ${r.status === 0 ? "ok" : `exit ${r.status}`}`);
  }
  if (p.file) {
    rmSync(p.file, { force: true });
    done.push(`removed ${p.file}`);
  }
  return done;
}
