/**
 * Savant downloads (ADR-094). Short, permanent links that always hand out the newest build:
 *
 *   GET /download/<target>            the latest installer, e.g. /download/mac → Savant-0.1.6-mac-apple-silicon.dmg
 *   GET /download/v<version>/<file>   one exact file of one release (the in-app updater uses these)
 *   GET /updates/latest.json          the updater manifest of the latest release
 *   GET /info                         {version, published_at, files} for the website (sizes, version label)
 *
 * The files are stored as release assets of a public, binary-only repository (RELEASES_REPO): free, with no bandwidth
 * cap. People never see that host: the bytes are streamed through this Worker under the product's own name, and the
 * version number lives in the release, not in the link, so links never go stale. Moving storage elsewhere only
 * changes `assetUrl` below.
 */

export interface Env {
  /** owner/name of the public repository whose releases hold the installers */
  RELEASES_REPO: string;
  /** optional: a read-only token, only to lift GitHub's anonymous API rate limit */
  GITHUB_TOKEN?: string;
  /** where `/` and unknown links send people */
  SITE_ORIGIN?: string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What a person can ask for → the platform and file type the release workflow names its files with. */
export const TARGETS: Record<string, { platform: string; ext: string; label: string }> = {
  mac: { platform: "darwin-aarch64", ext: ".dmg", label: "mac-apple-silicon" },
  "mac-intel": { platform: "darwin-x86_64", ext: ".dmg", label: "mac-intel" },
  windows: { platform: "windows-x86_64", ext: "-setup.exe", label: "windows" },
  "windows-msi": { platform: "windows-x86_64", ext: ".msi", label: "windows" },
  "windows-msix": { platform: "windows-x86_64", ext: ".msix", label: "windows" },
  linux: { platform: "linux-x86_64", ext: ".AppImage", label: "linux-x64" },
  "linux-deb": { platform: "linux-x86_64", ext: ".deb", label: "linux-x64" },
  "linux-rpm": { platform: "linux-x86_64", ext: ".rpm", label: "linux-x64" },
  "linux-arm": { platform: "linux-aarch64", ext: ".AppImage", label: "linux-arm64" },
  "linux-arm-deb": { platform: "linux-aarch64", ext: ".deb", label: "linux-arm64" },
  "linux-arm-rpm": { platform: "linux-aarch64", ext: ".rpm", label: "linux-arm64" },
};

/** Links printed before ADR-094 (`/download/Savant_darwin-aarch64.dmg`) keep working. */
export function legacyTarget(file: string): string | null {
  const m = /^Savant_([a-z]+-[a-z0-9_]+?)(-setup\.exe|\.[A-Za-z]+)$/.exec(file);
  if (!m) return null;
  const hit = Object.entries(TARGETS).find(([, t]) => t.platform === m[1] && t.ext === m[2]);
  return hit?.[0] ?? null;
}

interface Asset {
  name: string;
  size: number;
}
export interface Release {
  version: string;
  tag: string;
  published_at: string | null;
  assets: Asset[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The asset of `release` for a target (current `Savant_<v>_…` names and the pre-rebrand `CORTEX-54_<v>_…` ones). */
export function pick(release: Release, target: string): Asset | null {
  const t = TARGETS[target];
  if (!t) return null;
  const re = new RegExp(`^(?:Savant|CORTEX-54)_\\d[^_]*_${esc(t.platform)}${esc(t.ext)}$`);
  return release.assets.find((a) => re.test(a.name)) ?? null;
}

export const niceName = (version: string, target: string) => {
  const t = TARGETS[target];
  return t ? `Savant-${version}-${t.label}${t.ext}` : `Savant-${version}`;
};

const assetUrl = (repo: string, tag: string, file: string) =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;

const TTL = 300_000;
let memo: { at: number; repo: string; release: Release } | null = null;
/** Tests reset the in-memory release cache between cases. */
export const resetCache = () => {
  memo = null;
};

/** The latest published release: the API when it answers, otherwise the tag from the /releases/latest redirect. */
export async function latest(env: Env, f: Fetch, now = Date.now()): Promise<Release | null> {
  if (memo && memo.repo === env.RELEASES_REPO && now - memo.at < TTL) return memo.release;
  // one lookup per Cloudflare location every 5 minutes (keeps far under GitHub's anonymous API limit)
  const cache = typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
  const key = `https://savant-downloads.cache/latest/${env.RELEASES_REPO}`;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) {
    const release = (await hit.json()) as Release;
    memo = { at: now, repo: env.RELEASES_REPO, release };
    return release;
  }
  let release: Release | null = null;
  const r = await f(`https://api.github.com/repos/${env.RELEASES_REPO}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "savant-downloads",
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
  }).catch(() => null);
  if (r?.ok) {
    const j = (await r.json()) as {
      tag_name: string;
      published_at: string | null;
      assets: { name: string; size: number }[];
    };
    release = {
      tag: j.tag_name,
      version: j.tag_name.replace(/^v/, ""),
      published_at: j.published_at,
      assets: j.assets.map((a) => ({ name: a.name, size: a.size })),
    };
  } else {
    // rate-limited or down: the web redirect still names the tag, and the workflow's file names are predictable
    const w = await f(`https://github.com/${env.RELEASES_REPO}/releases/latest`, {
      redirect: "manual",
    }).catch(() => null);
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(w?.headers.get("location") ?? "")?.[1];
    if (tag) {
      const t = decodeURIComponent(tag);
      const version = t.replace(/^v/, "");
      // the release page lists the exact file names (no API quota); guess the workflow's names only if it doesn't answer
      const page = await f(
        `https://github.com/${env.RELEASES_REPO}/releases/expanded_assets/${encodeURIComponent(t)}`,
        {
          headers: { "user-agent": "savant-downloads" },
        },
      ).catch(() => null);
      const html = page?.ok ? await page.text() : "";
      const names = [
        ...new Set(
          [...html.matchAll(/\/releases\/download\/[^/"]+\/([A-Za-z0-9._-]+)"/g)].map((m) => m[1] as string),
        ),
      ];
      release = {
        tag: t,
        version,
        published_at: null,
        assets: names.length
          ? names.map((name) => ({ name, size: 0 }))
          : Object.values(TARGETS).map((x) => ({ name: `Savant_${version}_${x.platform}${x.ext}`, size: 0 })),
      };
    }
  }
  if (release) {
    memo = { at: now, repo: env.RELEASES_REPO, release };
    await cache
      ?.put(key, Response.json(release, { headers: { "cache-control": "public, max-age=300" } }))
      .catch(() => undefined);
  }
  return release;
}

const TYPES: Record<string, string> = {
  ".dmg": "application/x-apple-diskimage",
  ".msi": "application/x-msi",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msix": "application/msix",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
  ".json": "application/json",
};
const typeOf = (name: string) => TYPES[/\.[A-Za-z]+$/.exec(name)?.[0] ?? ""] ?? "application/octet-stream";

/** Stream one file from storage under `filename`, passing Range through so interrupted downloads resume. */
async function stream(
  req: Request,
  f: Fetch,
  url: string,
  filename: string,
  cache: string,
): Promise<Response> {
  const range = req.headers.get("range");
  const up = await f(url, {
    method: req.method === "HEAD" ? "HEAD" : "GET",
    headers: { "user-agent": "savant-downloads", ...(range ? { range } : {}) },
    redirect: "follow",
  }).catch(() => null);
  if (!up || (up.status !== 200 && up.status !== 206))
    return text(
      up?.status === 404 ? "That file isn't in this release." : "Downloads are unavailable right now.",
      up?.status === 404 ? 404 : 502,
    );
  const h = new Headers({
    "content-type": typeOf(filename),
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": cache,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  });
  for (const k of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }
  return new Response(req.method === "HEAD" ? null : up.body, { status: up.status, headers: h });
}

const text = (msg: string, status: number) =>
  new Response(`${msg}\n\nAll downloads: https://getsavant.pro/docs/install/\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

const json = (b: unknown, status = 200) =>
  Response.json(b, {
    status,
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
  });

export async function handle(req: Request, env: Env, f: Fetch = (u, i) => fetch(u, i)): Promise<Response> {
  const url = new URL(req.url);
  const site = env.SITE_ORIGIN ?? "https://getsavant.pro";
  if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed.", 405);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return Response.redirect(`${site}/docs/install/`, 302);

  // one exact file of one release (stable for the updater: versioned URLs never change)
  let m = /^\/download\/v(\d+\.\d+\.\d+[0-9A-Za-z.-]*)\/([A-Za-z0-9._-]+)$/.exec(p);
  if (m) {
    const [, version, file] = m as unknown as [string, string, string];
    return stream(
      req,
      f,
      assetUrl(env.RELEASES_REPO, `v${version}`, file),
      file,
      "public, max-age=86400, immutable",
    );
  }

  m = /^\/download\/([A-Za-z0-9._-]+)$/.exec(p);
  if (m) {
    const target = TARGETS[m[1] as string] ? (m[1] as string) : legacyTarget(m[1] as string);
    if (!target) return text("There's no download by that name.", 404);
    const release = await latest(env, f);
    if (!release) return text("Downloads are unavailable right now.", 502);
    const asset = pick(release, target);
    if (!asset) return text("This release has no build for that system yet.", 404);
    return stream(
      req,
      f,
      assetUrl(env.RELEASES_REPO, release.tag, asset.name),
      niceName(release.version, target),
      "no-store",
    );
  }

  if (p === "/updates/latest.json") {
    const release = await latest(env, f);
    if (!release) return json({ error: "unavailable" }, 502);
    const r = await f(assetUrl(env.RELEASES_REPO, release.tag, "latest.json"), {
      headers: { "user-agent": "savant-downloads" },
    }).catch(() => null);
    if (!r?.ok) return json({ error: "no update manifest in the latest release" }, 404);
    return new Response(await r.text(), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  }

  if (p === "/info") {
    const release = await latest(env, f);
    if (!release) return json({ error: "unavailable" }, 502);
    const files: Record<string, { name: string; size: number }> = {};
    for (const target of Object.keys(TARGETS)) {
      const a = pick(release, target);
      if (a) files[target] = { name: niceName(release.version, target), size: a.size };
    }
    return json({ version: release.version, published_at: release.published_at, files });
  }

  return text("Not found.", 404);
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
