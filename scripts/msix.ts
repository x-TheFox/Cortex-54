/**
 * Package the Windows build as an MSIX (ADR-079), next to the .msi and the NSIS installer. Runs on the Windows release
 * runner (plain Node, type stripping):
 *
 *   node scripts/msix.ts <file.msi> <version> <out.msix>
 *
 * It unpacks the MSI with an administrative install (the exact layout the installer would create), adds an
 * AppxManifest and the tile logos, and packs it with the Windows SDK's makeappx. The package is unsigned on purpose
 * (no Windows code-signing certificate, operator decision): its publisher carries Microsoft's "unsigned package" OID,
 * so Windows 11 installs it with `Add-AppxPackage -AllowUnsigned`; the Microsoft Store re-signs it with the publisher
 * identity from Partner Center (change MSIX_PUBLISHER / MSIX_NAME for a Store submission).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** MSIX versions are four numbers; the fourth must be 0 for the Store. Pure. */
export function msixVersion(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`bad version ${v}`);
  return `${m[1]}.${m[2]}.${m[3]}.0`;
}

const UNSIGNED_OID = "OID.2.25.311729368913984317654407730594956997722=1";
const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function manifest(o: { version: string; exe: string; publisher?: string; name?: string }): string {
  const publisher = o.publisher ?? `CN=Savant, ${UNSIGNED_OID}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${xml(o.name ?? "CORTEX54.Desktop")}" Publisher="${xml(publisher)}" Version="${msixVersion(o.version)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Savant</DisplayName>
    <PublisherDisplayName>Savant</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="CORTEX54" Executable="${xml(o.exe)}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Savant" Description="Autonomous trading agent with a constitutional risk engine"
        BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <Capability Name="privateNetworkClientServer" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

function makeappx(): string {
  const base = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const found = readdirSync(base)
    .filter((v) => /^10\./.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((v) => join(base, v, "x64", "makeappx.exe"))
    .find((p) => existsSync(p));
  if (!found) throw new Error("makeappx.exe not found (Windows SDK)");
  return found;
}

if (basename(process.argv[1] ?? "") === "msix.ts") {
  const [msi, version, out] = process.argv.slice(2);
  if (!msi || !version || !out)
    throw new Error("usage: node scripts/msix.ts <file.msi> <version> <out.msix>");
  const stage = resolve("msix-stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const x = spawnSync(
    "cmd",
    ["/c", "start", "/wait", "msiexec", "/a", resolve(msi), "/qn", `TARGETDIR=${stage}`],
    {
      stdio: "inherit",
    },
  );
  if (x.status !== 0) throw new Error(`msiexec /a failed (${x.status})`);
  // the app folder is the one holding the bundled Node runtime next to the app's own exe
  const node = walk(stage).find((f) => basename(f).toLowerCase() === "node.exe");
  if (!node) throw new Error("node.exe sidecar not found in the MSI layout");
  const root = dirname(node);
  const exe = readdirSync(root).find(
    (f) => f.toLowerCase().endsWith(".exe") && !/^(node|uninstall)/i.test(f),
  );
  if (!exe) throw new Error(`no app exe in ${root}`);
  mkdirSync(join(root, "Assets"), { recursive: true });
  for (const f of ["Square150x150Logo.png", "Square44x44Logo.png", "StoreLogo.png"])
    copyFileSync(join("desktop", "src-tauri", "icons", f), join(root, "Assets", f));
  writeFileSync(
    join(root, "AppxManifest.xml"),
    manifest({
      version,
      exe,
      ...(process.env.MSIX_PUBLISHER ? { publisher: process.env.MSIX_PUBLISHER } : {}),
      ...(process.env.MSIX_NAME ? { name: process.env.MSIX_NAME } : {}),
    }),
  );
  const p = spawnSync(makeappx(), ["pack", "/d", root, "/p", resolve(out), "/o"], { stdio: "inherit" });
  if (p.status !== 0) throw new Error(`makeappx failed (${p.status})`);
  console.log(`MSIX → ${out} (app ${exe})`);
}
