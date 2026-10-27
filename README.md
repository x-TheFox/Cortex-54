# Savant

An autonomous trading agent that runs at **$0/month** on free tiers (Cloudflare Workers Free, GitHub Actions,
free LLM APIs). It trades a $54 Alpaca paper account and a $54 real account in lockstep and is controlled
from Discord.

- **Models reason, code computes, the risk engine decides, the operator governs.**
- A four-tier thinking funnel (math → Clef-flash → Clef → cross-family LLM bull/bear court) means expensive
  thinking happens only on the best ~1% of ideas.
- An 8-rule constitution (`config/constitution.json`) that no model can override.

Start with [`CLAUDE.md`](CLAUDE.md), then [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/FREE_TIER_BUDGET.md`](docs/FREE_TIER_BUDGET.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md).
Setup steps are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

```bash
pnpm install
pnpm typecheck && pnpm test
```

**Status:** all roadmap phases (0–6) are built and deployed. PAPER trades autonomously; a second paper account
(LAB) forward-tests new strategies; LIVE (real money) stays dormant until PAPER passes the 30-day graduation gate
and the operator ratifies it. Current state and history: `CLAUDE.md` §11 and `docs/DECISIONS.md`.

> This is an experiment with a very small amount of real money. Nothing here is financial advice.
