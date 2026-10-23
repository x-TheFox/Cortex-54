# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React (operator's explicit request, 2026-10-23), built to static files and served as Cloudflare Workers static
assets from the `cortex` worker. $0 hosting, no third-party runtime services, strict CSP (self-hosted fonts and
scripts only). The Worker bundle must stay small; the web build lives outside it.

## Users

One user: the operator (owner of the repo and both Alpaca accounts). Primarily on a desktop/laptop; the
phone is a secondary glance surface (Discord covers mobile alerts). The operator does not approve trades; they
govern an autonomous system and must not touch controls casually, because any manual command restarts the
30-day autonomous paper clock that gates real money.

## Product Purpose

CORTEX-54 is an autonomous trading agent that trades a $54 paper account (later a $54 live account) entirely on
free tiers. The web terminal is the operator's workstation for three jobs, all first-class:
1. **Glance** — is it healthy? equity, P&L, breaker band, mode, heartbeat, budget, regime.
2. **Watch it think** — the funnel (news/screeners → Clef triage → Clef 27B → bull-vs-bear court → contract),
   rejections, and what the brain did each pulse.
3. **Review and learn** — Governor report, LIVE graduation gate, memory (scar tissue, beliefs, reputation),
   options shadow lab, journal integrity.
Success: the operator understands the system's state and reasoning in seconds and trusts it enough to leave it
alone.

## Positioning

Not a broker dashboard and not a chat bot: a governance console for a self-improving trading organism whose
hard rails (constitution, risk engine, kill-switch) sit outside any model. The panel shows reasoning and rails
side by side, at a $54 scale where every cent and basis point is visible.

## Operating Context

Signed in via a single-use `/terminal` link from Discord (12 h session). Data arrives by polling the brain
(`/api/state` every 15 s while visible) plus D1 reads. Controls: pause, resume, autonomy dial (LIVE needs a
typed RATIFY), flatten (sells everything), unlock after RED (written postmortem), convene the court on a symbol.
Discord carries the same controls and the alarm stream.

## Capabilities and Constraints

- Every control has a Discord twin (shared command runner, parity test).
- Manual controls count as operator interventions for the LIVE gate; the UI must make that cost visible and
  make destructive actions (flatten, LIVE ratify) deliberate.
- Money in USD to the cent; quantities as decimals; times in UTC internally, ET only for display.
- Data that is stale, unknown, or failing must look different from healthy data (fail-closed system).
- No live trading yet: LIVE is dormant until ratified.

## Brand Commitments

Name: CORTEX-54. Existing Discord palette: emerald (#10B981) gains, crimson (#F43F5E) risk, cyan (#38BDF8) model
telemetry, amber/orange for warning bands. Operator voice: terse, factual, no hype.

## Evidence on Hand

Real data only: `/api/state`, `/api/court`, `/api/rejections`, `/api/memory`, `/api/options`, `/api/equity`.
No fabricated P&L, testimonials or performance claims. Early on most lists are empty; empty states must say why.

## Product Principles

1. Rails before reasoning: risk state is never below the fold.
2. Truth over comfort: stale or failing data is loud, not hidden.
3. Leave it alone: the safest action is usually none; controls are present but never inviting.
4. Every number traceable: show where a value comes from (source, time, model).

## Accessibility & Inclusion

Dark UI for long sessions; color is never the only signal for state (labels/icons accompany band colors);
keyboard reachable controls; respects reduced motion.
