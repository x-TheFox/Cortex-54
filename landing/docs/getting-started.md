---
title: Getting started
---
# Getting started

## 1. First launch: the demo

Savant opens on a **demo**: simulated money on live crypto prices, no accounts needed. Watch it for a while. The
cockpit stays quiet when nothing needs you; amber and red lights mean something does.

Before Savant may touch a real broker account it asks you to read and accept the terms and the risk disclosure.

## 2. Sign in to unlock trading

Paper and live trading need a plan (every plan starts with a 7-day free trial).

1. In Savant, open **Settings → Licence** and click **Sign in with your Savant account**.
2. Your browser opens getsavant.pro with a short code. Sign in with the **Whop account you bought Savant with**, check
   the code matches, and click **Sign in this computer**.
3. Back in the app, the licence shows as active. Done.

A licence works on one computer at a time. Signing in on a new computer asks whether to move it; the old computer stops
opening new trades at its next check (it keeps its stops on open positions). You can also manage computers from
[your account](/account/).

No browser on the trading machine (a server, a headless install)? Copy the **licence key** from
[your account](/account/) and paste it under **Settings → Licence → Use a licence key instead**.

## 3. Your paper account (Alpaca)

Savant trades through [Alpaca](https://alpaca.markets). Paper trading is free and uses pretend money against real
prices.

1. Create a free account at alpaca.markets and switch to **Paper Trading**.
2. In the paper dashboard, generate an **API key** (key ID and secret).
3. In Savant, **Settings → Trading account**, paste both and click **Test**. Then switch the mode to **Paper**.

Tip: start the paper account with the amount you'd really trade, so the record means something.

## 4. AI models

The court needs at least two language models from different families (one argues for a trade, one against).
**Settings → AI models** lists free options with links: a free **Groq** key and a free **Google AI Studio** key are
enough to start. You can also add any OpenAI- or Anthropic-compatible endpoint, or local models through Ollama or
LM Studio. Paid models are optional and you can cap their daily spend.

Optional: **Cloudflare AI** (free account) runs the fast screening models Savant was built around. Without it the
app uses a stand-in on your model pool and tells you so.

## 5. Alerts

Everything appears in the app's **FEED**. To get alarms and fills on your phone, turn on **ntfy** (free, no account)
in **Settings → Alerts** and scan the QR code, or connect a Discord bot.

## 6. Leave it alone

Savant trades by itself; there's no approve-each-trade mode. The safest action is usually none. Pause stops new
entries; Flatten sells everything; the tray has a kill switch. The weekly **Governor** may suggest changes that make
it more careful; they wait in **Settings → Governor proposals** until you approve them.

Next: **[Live trading](../live-trading/)** when you're ready, or **[Your account](../account/)**.
