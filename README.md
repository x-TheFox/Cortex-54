# Savant

Savant is an autonomous trading agent you run yourself: a desktop app (macOS, Windows, Linux) or a headless image.
Its agent, **Cortex**, reads the market and the news, argues every trade out in a bull-vs-bear court of language
models, and may only trade through a schema-checked contract that a deterministic risk engine sizes and can veto.

- **Models reason, code computes, the risk engine decides, you govern.** No model ever sets a quantity or a price.
- A four-tier thinking funnel (math → Clef-flash → Clef → a cross-family bull/bear court) spends expensive thinking
  only on the candidates that survive the cheap checks.
- An 8-rule constitution (`config/constitution.json`) that no model, Governor or button can change at runtime.
- An append-only, hash-chained journal of every decision.

Works with any account size (the $54 used throughout the docs is a worked example of how small it can go). It runs on
free tiers by default; paid models and your own cloud are optional and capped by you.

## What is true today (2026-10-27)

- **Paper trading is autonomous** on the operator's own deployment; a second paper account (LAB) forward-tests
  strategies before they may graduate. The court has convened; autonomous court entries on PAPER are still rare.
- **Live trading is off by default.** A live account joins at Stop 0 (no trading). It starts only when you ratify it
  in the app. The 30-day paper graduation gate is **advisory**: the app shows whether it has passed, in red when it
  hasn't, and you decide (ADR-083). The publisher's own live account has never traded.
- Every build phase in `docs/ROADMAP.md` is code-complete; several phase *exit gates* (multi-day clocks, the first
  Governor calibration PR, options shadow trades) are still running.

Start with [`CLAUDE.md`](CLAUDE.md), then [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/RISK_DOCTRINE.md`](docs/RISK_DOCTRINE.md). Brand notes: [`docs/BRAND.md`](docs/BRAND.md).

```bash
pnpm install
pnpm typecheck && pnpm test
```

> Trading involves risk of loss, including total loss of the money in your account. Savant is software, not
> financial advice, and past or simulated results do not predict future results. See the risk disclosure and terms
> shipped with the app (`docs/legal/`).
