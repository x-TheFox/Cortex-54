import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Doctrine } from "../src/contracts/doctrine.ts";
import {
  type Bench,
  benchTargets,
  type Catalog,
  catalogChanged,
  type HealReport,
  healChains,
  ingestCatalog,
  runBenchmark,
} from "../src/court/catalog.ts";
import { splitKeys } from "../src/court/keypool.ts";
import type { LlmProvider } from "../src/court/llm.ts";
import { listModels } from "../src/court/models.ts";
import { modelAllowed, type PoolConfig } from "../src/court/pool.ts";
import type { ProviderKeys } from "../src/court/providers.ts";

/**
 * The app's side of ADR-099: where the catalog and benchmark live (the data folder), when they refresh, and what the
 * built-in providers' model lists are called. The court reads the healed chains at its next (re)start.
 */

export const WEEK_MS = 7 * 86_400_000;
const catPath = (home: string) => join(home, "model-catalog.json");
const benchPath = (home: string) => join(home, "model-bench.json");

function read<T>(p: string): T | null {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  } catch {
    return null;
  }
}
export const loadCatalog = (home: string) => read<Catalog>(catPath(home));
export const loadBench = (home: string) => read<Bench>(benchPath(home));

/** The doctrine with this install's healed chains (no files yet = unchanged). */
export function healed(home: string, d: Doctrine): { d: Doctrine; report: HealReport } {
  return healChains(d, loadCatalog(home), loadBench(home));
}

type Fetch = (u: string, i?: RequestInit) => Promise<Response>;

/** Model-list sources for every connected provider and endpoint (first key of each). */
export function catalogSources(keys: ProviderKeys, pool: PoolConfig, f: Fetch = (u, i) => fetch(u, i)) {
  type Listed = { ok: true; models: string[]; free?: string[] } | { ok: false; error: string };
  const src: { provider: string; list: () => Promise<Listed> }[] = [];
  // a free-tier key (Gemini, Groq, NIM) lists what that free tier serves: every model there is free to this user
  const add = (provider: string, url: string, key: string | undefined) => {
    const k = splitKeys(key)[0];
    if (!k) return;
    src.push({
      provider,
      list: async (): Promise<Listed> => {
        const r = await listModels("openai", url, k, f);
        if (!r.ok) return r;
        const models = r.models.map((m) => m.replace(/^models\//, ""));
        return { ok: true, models, free: models };
      },
    });
  };
  add("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", keys.GEMINI_API_KEY);
  add("groq", "https://api.groq.com/openai/v1", keys.GROQ_API_KEY);
  add("nim", "https://integrate.api.nvidia.com/v1", keys.NVIDIA_API_KEY);
  // OpenRouter lists hundreds of models with prices: free = a zero prompt and completion price (or a `:free` id)
  if (splitKeys(keys.OPENROUTER_API_KEY)[0])
    src.push({
      provider: "openrouter",
      list: async (): Promise<Listed> => {
        const r = await f("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        const j = (await r.json()) as {
          data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[];
        };
        const rows = (j.data ?? []).filter(
          (x): x is { id: string; pricing?: { prompt?: string; completion?: string } } =>
            typeof x.id === "string",
        );
        return {
          ok: true,
          models: rows.map((x) => x.id),
          free: rows
            .filter(
              (x) =>
                x.id.endsWith(":free") ||
                (Number(x.pricing?.prompt) === 0 && Number(x.pricing?.completion) === 0),
            )
            .map((x) => x.id),
        };
      },
    });
  for (const e of pool.endpoints) {
    if (!e.enabled) continue;
    const k = splitKeys(e.key)[0] ?? "";
    src.push({
      provider: `ep:${e.id}`,
      list: async (): Promise<Listed> => {
        const r = await listModels(e.format, e.url, k, f);
        return r.ok ? { ok: true, models: r.models, free: e.tier === "paid" ? [] : r.models } : r;
      },
    });
  }
  return src;
}

/** ADR-099: one page of a provider's catalog for the model browser (search, free filter, picked state). Pure. */
export function catalogPage(
  c: Catalog | null,
  provider: string,
  q: {
    search?: string;
    free?: boolean;
    page?: number;
    per?: number;
    picked?: string[];
    scores?: Record<string, number>;
  },
): {
  provider: string;
  ok: boolean;
  total: number;
  page: number;
  pages: number;
  free_count: number;
  items: { id: string; free: boolean; picked: boolean; score: number | null }[];
  at: number | null;
} {
  const e = c?.providers[provider];
  const free = new Set(e?.free ?? []);
  const picked = new Set(q.picked ?? []);
  const words = (q.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const all = (e?.models ?? []).filter(
    (m) => (!q.free || free.has(m)) && words.every((w) => m.toLowerCase().includes(w)),
  );
  // picked first, then free, then by name: what a person scanning the list wants to see
  all.sort(
    (a, b) =>
      Number(picked.has(b)) - Number(picked.has(a)) ||
      Number(free.has(b)) - Number(free.has(a)) ||
      a.localeCompare(b),
  );
  const per = Math.max(10, Math.min(200, q.per ?? 50));
  const pages = Math.max(1, Math.ceil(all.length / per));
  const page = Math.max(1, Math.min(pages, q.page ?? 1));
  return {
    provider,
    ok: Boolean(e?.ok),
    total: all.length,
    page,
    pages,
    free_count: (e?.models ?? []).filter((m) => free.has(m)).length,
    items: all.slice((page - 1) * per, page * per).map((id) => ({
      id,
      free: free.has(id),
      picked: picked.has(id),
      score: q.scores?.[`${provider}/${id}`] ?? null,
    })),
    at: c?.at ?? null,
  };
}

/**
 * Refresh the catalog; benchmark when it changed or the last run is a week old. Returns what changed in the chains
 * (the caller restarts the court with them when anything did). Never throws.
 */
export async function refreshCatalog(o: {
  home: string;
  d: Doctrine;
  keys: ProviderKeys;
  pool: PoolConfig;
  providers: Partial<Record<string, LlmProvider>>;
  now?: number;
  fetcher?: Fetch;
  force?: boolean;
}): Promise<{ catalog: Catalog; bench: Bench | null; report: HealReport; changed: boolean }> {
  const now = o.now ?? Date.now();
  const prevCat = loadCatalog(o.home);
  const prevBench = loadBench(o.home);
  const before = JSON.stringify(healChains(o.d, prevCat, prevBench).d.llm_routing);
  const catalog = await ingestCatalog(catalogSources(o.keys, o.pool, o.fetcher), prevCat, now);
  writeFileSync(catPath(o.home), `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
  let bench = prevBench;
  if (o.force || !prevBench || now - prevBench.at >= WEEK_MS || catalogChanged(catalog)) {
    // ADR-099: test only what the user allows: free-only installs never test paid models; a provider left on
    // "recommended" only has candidates tested when one of its verified models disappeared (to find a replacement)
    const prefs = o.pool.prefs;
    const used = new Set(
      [...o.d.llm_routing.bull_chain, ...o.d.llm_routing.bear_chain, ...o.d.llm_routing.panel.chain].map(
        (h) => `${h.provider}/${h.model}`,
      ),
    );
    const allow = (p: string, m: string, free: boolean) => {
      if (!modelAllowed(prefs, p, m, free)) return false;
      if (p.startsWith("ep:"))
        return o.pool.endpoints.some((e) => `ep:${e.id}` === p && e.models.includes(m));
      const mode = prefs.models?.[p]?.mode ?? "recommended";
      if (mode !== "recommended") return mode !== "free" || free;
      return (catalog.providers[p]?.removed ?? []).some((x) => used.has(`${p}/${x}`)) && free;
    };
    bench = await runBenchmark(o.providers, benchTargets(o.d, catalog, 6, allow), now, prevBench).catch(
      () => prevBench,
    );
    if (bench) writeFileSync(benchPath(o.home), `${JSON.stringify(bench)}\n`, { mode: 0o600 });
  }
  const h = healChains(o.d, catalog, bench);
  return { catalog, bench, report: h.report, changed: JSON.stringify(h.d.llm_routing) !== before };
}
