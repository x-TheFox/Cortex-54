import { agentIdOf, canonical, type FeedBatch, type FeedRow, publicKeyOf, signPayload } from "./protocol.ts";

/** Hub settings an agent runs with (ADR-068). Off unless a hub URL and an agent key exist. */
export interface HubConfig {
  url: string;
  privateKey: string;
  /** derived from the private key when absent */
  publicKey?: string;
  name?: string;
  publish: boolean;
  /** agent ids whose court approvals become candidates here (still judged by this agent's own funnel) */
  follow: string[];
}

export type Http = (url: string, init?: RequestInit) => Promise<Response>;

export async function publishBatch(
  http: Http,
  cfg: HubConfig,
  rows: FeedRow[],
  head: { seq: number; sha: string },
  now: number,
): Promise<{ ok: boolean; status: number; body: string }> {
  const publicKey = cfg.publicKey ?? (await publicKeyOf(cfg.privateKey));
  const unsigned: Omit<FeedBatch, "sig"> = {
    v: 1,
    public_key: publicKey,
    ...(cfg.name ? { name: cfg.name.slice(0, 40) } : {}),
    sent_at: now,
    head,
    rows,
  };
  const sig = await signPayload(cfg.privateKey, unsigned);
  const r = await http(`${cfg.url.replace(/\/$/, "")}/v1/feed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonical({ ...unsigned, sig }),
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 200) };
}

export async function fetchFeed(http: Http, url: string, agentId: string, after: number): Promise<FeedRow[]> {
  const r = await http(`${url.replace(/\/$/, "")}/v1/agents/${agentId}/feed?after=${after}&kinds=CONTRACT`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`hub feed ${r.status}`);
  return ((await r.json()) as { rows: FeedRow[] }).rows;
}

export const selfId = async (cfg: HubConfig) =>
  agentIdOf(cfg.publicKey ?? (await publicKeyOf(cfg.privateKey)));

/** Hub settings from env/keys: HUB_URL, HUB_AGENT_KEY (pkcs8, base64), HUB_AGENT_NAME, HUB_PUBLISH, HUB_FOLLOW. */
export function hubFromEnv(e: Record<string, string | undefined>): HubConfig | null {
  if (!e.HUB_URL || !/^https?:\/\//.test(e.HUB_URL) || !e.HUB_AGENT_KEY) return null;
  return {
    url: e.HUB_URL,
    privateKey: e.HUB_AGENT_KEY,
    ...(e.HUB_AGENT_NAME ? { name: e.HUB_AGENT_NAME } : {}),
    publish: e.HUB_PUBLISH !== "false",
    follow: (e.HUB_FOLLOW ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => /^[0-9a-f]{16}$/.test(x)),
  };
}
