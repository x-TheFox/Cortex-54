/**
 * Protection for shipped builds (ADR-089). Closed-source software that runs on the customer's computer can't be made
 * impossible to reverse-engineer; the goal is to make it expensive and to make tampering detectable:
 *
 *  1. cortexd.mjs (already minified by esbuild, no source maps) is obfuscated: renamed identifiers, an encoded and
 *     rotated string table, numbers as expressions. Control-flow flattening and dead-code injection are off: they cost
 *     runtime speed in the trading loop for little extra protection.
 *  2. The Python research package ships as bytecode only (.pyc for the pinned Python minor version), no .py source.
 *  3. The desktop shell embeds the bundle's sha256 at build time and refuses to run a modified copy (build.rs, lib.rs).
 *  4. Licences are Ed25519-signed and machine-bound (ADR-086): patching the check is caught by (3); forging a licence
 *     needs the publisher's private key, which never ships.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

/** The Python minor version the research bytecode is compiled for (uv installs it on the user's computer). */
export const RESEARCH_PYTHON = "3.12";

export function obfuscateBundle(file: string): void {
  const src = readFileSync(file, "utf8");
  // the esbuild banner (createRequire, CORTEX_ROOT) must stay first and untouched: obfuscate the rest
  const res = JavaScriptObfuscator.obfuscate(src, {
    target: "node",
    compact: true,
    sourceMap: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 1,
    stringArrayIndexShift: true,
    splitStrings: false,
    numbersToExpressions: true,
    simplify: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    seed: 0,
  });
  writeFileSync(file, res.getObfuscatedCode());
}

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** Compile research/cortex_research to legacy-layout .pyc (importable without the .py) and drop the sources. */
export function compileResearch(dir: string): boolean {
  const pkg = join(dir, "cortex_research");
  try {
    execFileSync(
      "uv",
      [
        "run",
        "--no-project",
        "--python",
        RESEARCH_PYTHON,
        "python",
        "-m",
        "compileall",
        "-b",
        "-q",
        "-j",
        "0",
        pkg,
      ],
      { stdio: "inherit" },
    );
  } catch (e) {
    console.warn(
      `research bytecode skipped (uv/python ${RESEARCH_PYTHON} unavailable): ${String(e).slice(0, 120)}`,
    );
    return false;
  }
  for (const f of walk(pkg)) {
    if (f.endsWith(".py")) rmSync(f);
    if (f.includes("__pycache__")) rmSync(f, { force: true });
  }
  // the shipped project runs on exactly the Python the bytecode was compiled for
  writeFileSync(join(dir, ".python-version"), `${RESEARCH_PYTHON}\n`);
  const pp = join(dir, "pyproject.toml");
  writeFileSync(
    pp,
    readFileSync(pp, "utf8").replace(
      /requires-python = "[^"]*"/,
      `requires-python = "==${RESEARCH_PYTHON}.*"`,
    ),
  );
  return true;
}
