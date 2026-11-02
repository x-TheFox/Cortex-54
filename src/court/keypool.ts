import { type LlmProvider, type LlmRequest, type LlmResponse, ProviderError } from "./llm.ts";

/**
 * Two-tier round robin, inner tier (ADR-097). One provider can hold several API keys (free accounts, team keys, a
 * paid key next to a free one). Each call takes the next healthy key in round-robin order:
 *
 *   200 OK              → return; the pointer moves on, so the next call starts on the next key
 *   429 rate limit      → that key cools down for a while; try the next key at once
 *   401 / 403 revoked   → that key is set aside for an hour; try the next key at once
 *   every key cooling   → throw a 429, so the router (the outer tier) marks the whole provider exhausted, puts it on
 *                         cooldown and moves to the next provider; when every provider is exhausted the brain holds
 *                         new entries (REDUCE_ONLY semantics) until one recovers
 *   anything else       → rethrown unchanged (timeouts and 5xx are the router's to handle)
 *
 * Keys are never logged; a key is named by its position ("key 2 of 3").
 */
export class KeyPoolProvider implements LlmProvider {
  private next = 0;
  private readonly until: number[];
  constructor(
    readonly name: string,
    private readonly members: LlmProvider[],
    private readonly now: () => number = () => Date.now(),
    readonly rateCooldownMs = 60_000,
    readonly revokedCooldownMs = 60 * 60_000,
  ) {
    if (members.length === 0) throw new Error("a key pool needs at least one key");
    this.until = members.map(() => 0);
  }

  get size(): number {
    return this.members.length;
  }

  /** Keys that can be tried right now. */
  healthy(): number {
    const t = this.now();
    return this.until.filter((u) => u <= t).length;
  }

  /** True when every key is cooling down (the outer tier treats the provider as exhausted). */
  depleted(): boolean {
    return this.healthy() === 0;
  }

  /** When the first key comes back (epoch ms), for the "recovers at" note. */
  recoversAt(): number {
    return Math.min(...this.until);
  }

  async complete(model: string, req: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
    const n = this.members.length;
    let last: unknown = null;
    for (let k = 0; k < n; k++) {
      const i = (this.next + k) % n;
      if ((this.until[i] ?? 0) > this.now()) continue;
      try {
        const r = await (this.members[i] as LlmProvider).complete(model, req, timeoutMs);
        this.next = (i + 1) % n;
        return r;
      } catch (e) {
        const status = e instanceof ProviderError ? e.status : /\b(429|401|403)\b/.exec(String(e))?.[1];
        const s = Number(status);
        if (s === 429) this.until[i] = this.now() + this.rateCooldownMs;
        else if (s === 401 || s === 403) this.until[i] = this.now() + this.revokedCooldownMs;
        else throw e;
        last = e;
      }
    }
    this.next = (this.next + 1) % n;
    throw new ProviderError(
      this.name,
      429,
      `all ${n} key${n === 1 ? "" : "s"} rate-limited or revoked${last ? "" : " (cooling down)"}`,
    );
  }
}

/** Several keys pasted into one field: comma, semicolon, whitespace or newline separated; duplicates dropped. */
export function splitKeys(v: string | undefined): string[] {
  return [
    ...new Set(
      (v ?? "")
        .split(/[\s,;]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    ),
  ];
}

/** One provider per key behind a pool, or the single provider when there is one key. */
export function pooled(
  name: string,
  keys: string[],
  make: (key: string) => LlmProvider,
  now?: () => number,
): LlmProvider | null {
  if (keys.length === 0) return null;
  if (keys.length === 1) return make(keys[0] as string);
  return new KeyPoolProvider(name, keys.map(make), now);
}
