# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React (2026-10-23), built to static files. The same cockpit is served by the local Savant app (desktop, from
cortexd) and by a customer's own cloud brain (Cloudflare Workers static assets). No third-party runtime services,
strict CSP (self-hosted fonts and scripts only). The Worker bundle must stay small; the web build lives outside it.

## Users

Each customer is the single operator of their own install: one person, their own Alpaca accounts, usually a
desktop or laptop (the app), sometimes a phone on the same Wi-Fi (glance and pause; destructive commands need a
fresh pairing). They do not approve trades; they govern an autonomous system. Manual trading commands count as
interventions on the 30-day paper record shown next to LIVE, so the controls are present but never inviting.

## Product Purpose

Savant is an autonomous trading agent (Cortex) for accounts of any size, free tiers by default. The cockpit is the
operator's workstation for three jobs, all first-class:
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
side by side, down to the cent and the basis point, so it works at very small account sizes ($54 is the worked
example in the docs).

## Operating Context

Desktop: the app signs you in on your own computer (30-day session); a phone pairs once from a QR code. A cloud
brain: a single-use sign-in link (12 h session). Data arrives by polling the brain (`/api/state` every 15 s while
visible). Controls: pause, resume, autonomy dial (LIVE needs a typed RATIFY on a fresh sign-in), flatten (sells
everything), unlock after RED (written postmortem), convene the court on a symbol. Discord is an optional add-on
with the same controls and the alarm stream.

## Capabilities and Constraints

- The app and the optional Discord bot share one command runner (parity test), so a control behaves the same in both.
- Manual controls count as operator interventions for the LIVE gate; the UI must make that cost visible and
  make destructive actions (flatten, LIVE ratify) deliberate.
- Money in USD to the cent; quantities as decimals; times in UTC internally, ET only for display.
- Data that is stale, unknown, or failing must look different from healthy data (fail-closed system).
- LIVE joins at Stop 0 and trades only after the operator ratifies it; the paper graduation gate is shown as advice
  (red until it passes), not enforced (ADR-083).

## Brand Commitments

Name: Savant. Existing Discord palette: emerald (#10B981) gains, crimson (#F43F5E) risk, cyan (#38BDF8) model
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
