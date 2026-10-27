/**
 * After `tauri build --target <triple>` in the release workflow (ADR-077): find the installers and updater bundles,
 * give them names that can't collide across platforms, and write `updater-<platform>.json` with the signature the
 * updater manifest (latest.json) needs. Uploading is the workflow's job (`gh release upload`).
 *
 *   node scripts/release-assets.ts <triple> <platform> <version> <outDir>
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [triple, platform, version, outDir] = process.argv.slice(2);
if (!triple || !platform || !version || !outDir)
  throw new Error("usage: <triple> <platform> <version> <outDir>");
const bundle = join("desktop", "src-tauri", "target", triple, "release", "bundle");
if (!existsSync(bundle)) throw new Error(`no bundle at ${bundle}`);
mkdirSync(outDir, { recursive: true });

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() && !p.endsWith(".app") ? walk(p) : [p];
  });
const files = walk(bundle);
const arch = platform.split("-")[1] ?? "x86_64";
const copied: string[] = [];
const put = (src: string, name: string) => {
  copyFileSync(src, join(outDir, name));
  copied.push(name);
  return name;
};

// installers people download
for (const f of files) {
  const base = f.split(/[\\/]/).pop() ?? "";
  if (/\.(dmg|msi|deb|rpm|AppImage)$/.test(base) || /-setup\.exe$/.test(base)) {
    const ext = base.match(/(-setup\.exe|\.[A-Za-z]+)$/)?.[1] ?? "";
    put(f, `CORTEX-54_${version}_${platform}${ext}`);
  }
}

// the updater bundle + its signature: .app.tar.gz (macOS), the AppImage (Linux), the NSIS installer (Windows)
const updaterSrc = files.find((f) =>
  platform.startsWith("darwin")
    ? f.endsWith(".app.tar.gz")
    : platform.startsWith("linux")
      ? f.endsWith(".AppImage")
      : f.endsWith("-setup.exe"),
);
const sig =
  updaterSrc && existsSync(`${updaterSrc}.sig`) ? readFileSync(`${updaterSrc}.sig`, "utf8").trim() : null;
if (updaterSrc && sig) {
  const ext = platform.startsWith("darwin")
    ? ".app.tar.gz"
    : platform.startsWith("linux")
      ? ".AppImage"
      : "-setup.exe";
  const name = platform.startsWith("darwin")
    ? put(updaterSrc, `CORTEX-54_${version}_${platform}${ext}`)
    : `CORTEX-54_${version}_${platform}${ext}`;
  writeFileSync(
    join(outDir, `updater-${platform}.json`),
    JSON.stringify({ platform, name, signature: sig, arch }),
  );
  copied.push(`updater-${platform}.json`);
}
console.log(copied.join("\n"));
if (!copied.length) throw new Error("no installers found");
