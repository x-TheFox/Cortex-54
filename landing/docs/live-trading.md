---
title: Live trading
---
# Live trading

Live trading uses real money. Read the [risk disclosure](/legal/risk.html) first; you can lose all of the money in the
account.

## How it switches on

1. **Settings → Trading account → Live**: paste your Alpaca **live** API key and secret and click **Test** (read-only).
2. The live account joins at **Stop 0**: Savant watches it but places nothing.
3. In the cockpit, the LIVE panel shows the **graduation gate**: how the paper account has done (30 days of
   autonomous paper trading, at least 25 closed trades, positive results after fees and more). It's shown in red until
   it passes. It's advice, not a lock: you decide.
4. To switch live on, type **RATIFY** on a fresh sign-in and confirm it again between 10 minutes and 24 hours later.

From then on live trades by itself, under the same rules as paper: cash only, a stop on every position, hard limits
on risk per trade and per day, and breakers that shrink it and finally stop it after losses. Live never unlocks itself
after a red breaker: you write a short postmortem to unlock it.

## Stopping it

- **Pause**: no new entries; open positions keep their stops.
- **Flatten**: sells everything on that account (type FLATTEN to confirm).
- **Kill switch** (tray): stops new entries on every account until you re-arm.

From a phone on your Wi-Fi you can watch and pause; flattening, resuming or changing autonomy from a phone needs a
fresh pairing from the computer.
