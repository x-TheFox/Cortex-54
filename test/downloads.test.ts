import { beforeEach, describe, expect, it } from "vitest";
import {
  type Env,
  handle,
  legacyTarget,
  niceName,
  pick,
  resetCache,
  TARGETS,
} from "../workers/downloads/src/index.ts";

const env: Env = { RELEASES_REPO: "o/bins" };
const V = "0.2.0";
const names = Object.values(TARGETS).map((t) => `Savant_${V}_${t.platform}${t.ext}`);

function fakeGitHub(opts: { apiDown?: boolean } = {}) {
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.endsWith("/releases/latest") && url.includes("api.github.com")) {
      if (opts.apiDown) return new Response("rate limited", { status: 403 });
      return Response.json({
        tag_name: `v${V}`,
        published_at: "2026-10-28T00:00:00Z",
        assets: [
          ...names.map((name) => ({ name, size: 1000 })),
          { name: `Savant_${V}_darwin-aarch64.app.tar.gz`, size: 9 },
          { name: "latest.json", size: 5 },
        ],
      });
    }
    if (url === "https://github.com/o/bins/releases/latest")
      return new Response(null, {
        status: 302,
        headers: { location: `https://github.com/o/bins/releases/tag/v${V}` },
      });
    const m = /releases\/download\/([^/]+)\/(.+)$/.exec(url);
    if (m) {
      const file = decodeURIComponent(m[2] as string);
      if (file === "latest.json") return Response.json({ version: V });
      if (!names.includes(file) && !file.endsWith(".app.tar.gz")) return new Response("nf", { status: 404 });
      const range = new Headers(init?.headers).get("range");
      return range
        ? new Response("partial", {
            status: 206,
            headers: { "content-range": "bytes 0-6/1000", "content-length": "7" },
          })
        : new Response(`bytes of ${file}`, { headers: { "content-length": "1000" } });
    }
    return new Response("?", { status: 404 });
  };
  return { f, calls };
}

const get = (path: string, f: ReturnType<typeof fakeGitHub>["f"], headers?: HeadersInit) =>
  handle(new Request(`https://dl.example${path}`, headers ? { headers } : {}), env, f);

describe("Savant downloads (ADR-094)", () => {
  beforeEach(resetCache);

  it("serves the newest installer under a clean, versioned name from a version-less link", async () => {
    const { f } = fakeGitHub();
    const r = await get("/download/mac", f);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe(
      `attachment; filename="Savant-${V}-mac-apple-silicon.dmg"`,
    );
    expect(await r.text()).toBe(`bytes of Savant_${V}_darwin-aarch64.dmg`);
    const w = await get("/download/windows", f);
    expect(w.headers.get("content-disposition")).toContain(`Savant-${V}-windows-setup.exe`);
  });

  it("every target resolves, and old printed links still work", async () => {
    const { f } = fakeGitHub();
    for (const t of Object.keys(TARGETS)) expect((await get(`/download/${t}`, f)).status).toBe(200);
    expect(legacyTarget("Savant_darwin-x86_64.dmg")).toBe("mac-intel");
    expect(legacyTarget("Savant_windows-x86_64-setup.exe")).toBe("windows");
    expect((await get("/download/Savant_linux-aarch64.deb", f)).status).toBe(200);
    expect((await get("/download/nope", f)).status).toBe(404);
  });

  it("matches pre-rebrand file names", () => {
    const rel = {
      version: "0.1.5",
      tag: "v0.1.5",
      published_at: null,
      assets: [{ name: "CORTEX-54_0.1.5_darwin-aarch64.dmg", size: 1 }],
    };
    expect(pick(rel, "mac")?.name).toBe("CORTEX-54_0.1.5_darwin-aarch64.dmg");
    expect(pick(rel, "windows")).toBeNull();
    expect(niceName("0.1.5", "linux-arm-deb")).toBe("Savant-0.1.5-linux-arm64.deb");
  });

  it("passes Range through so interrupted downloads resume", async () => {
    const { f } = fakeGitHub();
    const r = await get("/download/linux", f, { range: "bytes=0-6" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-6/1000");
  });

  it("reads exact (pre-rebrand) names from the release page when the API is rate-limited", async () => {
    const f = async (url: string): Promise<Response> => {
      if (url.includes("api.github.com")) return new Response("limited", { status: 403 });
      if (url.endsWith("/releases/latest"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://github.com/o/bins/releases/tag/v0.1.5" },
        });
      if (url.includes("/expanded_assets/"))
        return new Response(
          '<a href="/o/bins/releases/download/v0.1.5/CORTEX-54_0.1.5_darwin-aarch64.dmg" rel="nofollow">',
        );
      if (url.endsWith("/v0.1.5/CORTEX-54_0.1.5_darwin-aarch64.dmg")) return new Response("dmg");
      return new Response("nf", { status: 404 });
    };
    const r = await get("/download/mac", f);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("Savant-0.1.5-mac-apple-silicon.dmg");
  });

  it("keeps working when the API is rate-limited (tag from the redirect, predictable names)", async () => {
    const { f } = fakeGitHub({ apiDown: true });
    const r = await get("/download/mac-intel", f);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain(`Savant-${V}-mac-intel.dmg`);
  });

  it("caches the release lookup", async () => {
    const { f, calls } = fakeGitHub();
    await get("/download/mac", f);
    await get("/download/linux", f);
    expect(calls.filter((c) => c.includes("api.github.com")).length).toBe(1);
  });

  it("serves exact versioned files, the updater manifest and info", async () => {
    const { f } = fakeGitHub();
    const u = await get(`/download/v${V}/Savant_${V}_darwin-aarch64.app.tar.gz`, f);
    expect(u.status).toBe(200);
    expect(u.headers.get("cache-control")).toContain("immutable");
    expect(await (await get("/updates/latest.json", f)).json()).toEqual({ version: V });
    const info = (await (await get("/info", f)).json()) as {
      version: string;
      files: Record<string, { size: number }>;
    };
    expect(info.version).toBe(V);
    expect(Object.keys(info.files)).toHaveLength(Object.keys(TARGETS).length);
    expect((await get("/download/v1.0.0/../../etc", f)).status).toBe(404);
  });
});
