/**
 * THIRD_PARTY_NOTICES.md (ADR-087): every third-party component shipped inside a Savant installer, with its licence
 * text. Shipped in dist/cortexd/legal/ (so inside every installer), and readable from the app's About box.
 *
 *   tsx scripts/third-party.ts [out.md]
 *
 * Sources: the npm packages bundled into cortexd (production dependencies) and the web panel (its runtime packages and
 * fonts), the Rust crates linked into the desktop shell (`cargo metadata`, normal dependencies only), the official
 * Node.js runtime, and NOTICE.md's ported code. Licence texts come from each package's own LICENSE file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface Item {
  name: string;
  version: string;
  license: string;
  source: string;
  text: string | null;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

function licenseText(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile());
  if (!files.length) return null;
  return files
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim())
    .join("\n\n")
    .slice(0, 20_000);
}

// ------------------------------------------------------------------ npm (what the bundles actually contain)

/** Runtime packages of the web panel (bundled by Vite into public/), besides the production deps. */
const WEB_RUNTIME = [
  "react",
  "react-dom",
  "scheduler",
  "qrcode-generator",
  "@fontsource/b612",
  "@fontsource/b612-mono",
];

function npmItems(): Item[] {
  const prod = JSON.parse(
    execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { encoding: "utf8" }),
  ) as Record<string, { name: string; versions: string[]; paths: string[] }[]>;
  const out: Item[] = [];
  for (const [license, pkgs] of Object.entries(prod))
    for (const p of pkgs)
      out.push({
        name: p.name,
        version: p.versions.join(", "),
        license,
        source: `https://www.npmjs.com/package/${p.name}`,
        text: licenseText(p.paths[0] ?? ""),
      });
  for (const name of WEB_RUNTIME) {
    const dir = dirname(req.resolve(`${name}/package.json`, { paths: [process.cwd()] }));
    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version: string;
      license?: string;
    };
    out.push({
      name,
      version: pj.version,
      license: pj.license ?? "see text",
      source: `https://www.npmjs.com/package/${name}`,
      text: licenseText(dir),
    });
  }
  return out;
}

// ------------------------------------------------------------------ Rust crates linked into the desktop shell

function crateItems(): Item[] {
  let meta: {
    packages: {
      id: string;
      name: string;
      version: string;
      license?: string;
      manifest_path: string;
      repository?: string;
    }[];
    resolve: {
      root: string;
      nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[];
    };
  };
  try {
    meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1"], {
        cwd: "desktop/src-tauri",
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch {
    return [];
  }
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? [])
      if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
  }
  seen.delete(meta.resolve.root);
  return meta.packages
    .filter((p) => seen.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? "see text",
      source: p.repository ?? `https://crates.io/crates/${p.name}`,
      text: licenseText(dirname(p.manifest_path)),
    }));
}

// ------------------------------------------------------------------ the document

const req = (await import("node:module")).createRequire(import.meta.url);
const items = [...npmItems(), ...crateItems()];
const node = {
  name: "Node.js runtime",
  version: "bundled with the desktop app",
  license: "MIT (and the licences of its bundled dependencies)",
  source: "https://github.com/nodejs/node/blob/main/LICENSE",
  text: null,
};
const notice = existsSync("NOTICE.md") ? readFileSync("NOTICE.md", "utf8") : "";
const mpl = items.filter((i) => /MPL/.test(i.license));
const doc = [
  "# Third-party notices",
  "",
  "Savant ships with the open-source components below. Each keeps its own licence; nothing in the Savant licence",
  "limits your rights under them. Full licence texts follow the list.",
  "",
  mpl.length
    ? `Components under the Mozilla Public License 2.0 (${mpl.map((i) => i.name).join(", ")}) are used unmodified; their source code is available at the links below.\n`
    : "",
  "| Component | Version | Licence | Source |",
  "|---|---|---|---|",
  ...[node, ...items].map((i) => `| ${i.name} | ${i.version} | ${i.license} | ${i.source} |`),
  "",
  "## Ported and attributed code",
  "",
  notice.replace(/^# .*\n/, ""),
  "",
  "## Licence texts",
  "",
  // identical texts (most crates share the stock MIT/Apache text) are printed once, under every name that uses them
  ...[...grouped(items).entries()].map(
    ([text, names]) => `### ${names.join(", ")}\n\n\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\`\n`,
  ),
].join("\n");

function grouped(list: Item[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const i of list) {
    if (!i.text) continue;
    // normalise whitespace and the copyright line so the stock texts collapse
    const key = i.text.replace(/\r/g, "").trim();
    m.set(key, [...(m.get(key) ?? []), `${i.name} ${i.version}`]);
  }
  return m;
}
const out = process.argv[2] ?? "THIRD_PARTY_NOTICES.md";
writeFileSync(out, doc);
console.log(`${out}: ${items.length + 1} components (${mpl.length} MPL-2.0)`);
