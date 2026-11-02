import { type ChildProcess, spawn } from "node:child_process";

/**
 * Keep the computer awake (ADR-096). While a court hearing runs (or always, if the user chooses), Savant holds an OS
 * power assertion so system sleep and app suspension don't cut a debate short. The display may still sleep: only
 * the system is kept awake.
 *
 *   macOS    `caffeinate -i -s -w <pid>`  (idle and system sleep; ends by itself if Savant exits)
 *   Windows  SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) from a small PowerShell helper
 *   Linux    `systemd-inhibit --what=idle:sleep …` around a loop that waits for Savant's pid (where logind exists)
 *
 * Every helper is tied to Savant's own process id or killed on release and on exit, so an assertion never outlives
 * the app. If the platform has no helper, holding is a no-op and Savant keeps working (stops and exits don't need
 * the computer to stay awake: the broker holds the stops).
 */

export type Spawner = (cmd: string, args: string[]) => ChildProcess;

export function assertionCommand(
  platform: NodeJS.Platform,
  pid: number,
  why: string,
): [string, string[]] | null {
  if (platform === "darwin") return ["caffeinate", ["-i", "-s", "-w", String(pid)]];
  if (platform === "win32")
    return [
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held until this helper exits; it exits when Savant's process does
        `$s='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
          `$k=Add-Type -MemberDefinition $s -Name P -Namespace W -PassThru;` +
          `[void]$k::SetThreadExecutionState(0x80000001);` +
          `try { Wait-Process -Id ${pid} } finally { [void]$k::SetThreadExecutionState(0x80000000) }`,
      ],
    ];
  if (platform === "linux")
    return [
      "systemd-inhibit",
      [
        "--what=idle:sleep",
        "--who=Savant",
        `--why=${why.replace(/[^\w ,.-]/g, "").slice(0, 80)}`,
        "--mode=block",
        // ends by itself when Savant's process does, even after a crash
        "sh",
        "-c",
        `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`,
      ],
    ];
  return null;
}

export class PowerGuard {
  private child: ChildProcess | null = null;
  private reasons = new Set<string>();
  private failed = false;
  constructor(
    private readonly spawner: Spawner = (c, a) =>
      spawn(c, a, { stdio: "ignore", detached: false, windowsHide: true }),
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly pid: number = process.pid,
  ) {
    const off = () => this.stop();
    process.once("exit", off);
  }

  /** Is an assertion held right now? */
  get held(): boolean {
    return this.child !== null;
  }
  get why(): string[] {
    return [...this.reasons];
  }

  /** Hold the assertion for `reason` (idempotent per reason). */
  hold(reason: string): void {
    this.reasons.add(reason);
    if (this.child || this.failed) return;
    const cmd = assertionCommand(this.platform, this.pid, `Savant: ${[...this.reasons].join(", ")}`);
    if (!cmd) return;
    try {
      const c = this.spawner(cmd[0], cmd[1]);
      c.once("error", () => {
        this.failed = true; // no helper on this system: don't retry every tick
        this.child = null;
      });
      c.once("exit", () => {
        if (this.child === c) this.child = null;
      });
      c.unref?.();
      this.child = c;
    } catch {
      this.failed = true;
    }
  }

  /** Drop `reason`; the assertion ends when no reason is left. */
  release(reason: string): void {
    this.reasons.delete(reason);
    if (this.reasons.size === 0) this.stop();
  }

  /** Hold exactly while `on` is true. */
  set(reason: string, on: boolean): void {
    if (on) this.hold(reason);
    else this.release(reason);
  }

  stop(): void {
    this.reasons.clear();
    const c = this.child;
    this.child = null;
    try {
      c?.kill();
    } catch {
      /* already gone */
    }
  }
}
