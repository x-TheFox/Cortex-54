# How customers get and run CORTEX-54

Decision record for the commercial version (operator, 2026-10-26). The short version: **we ship software, the customer
runs it.** We host exactly one service, the community hub, and it never touches anyone's broker keys or money.

## What a customer gets

| Piece | What it is | Who runs it |
|---|---|---|
| **CORTEX-54 desktop app** (macOS, Windows, Linux) | The whole brain, the cockpit and a tray pill in one installer. Starts in a keyless demo on live crypto prices; paper mode with the customer's own free Alpaca paper account. Research, Kronos and the Governor run on the same machine. | The customer, on their computer |
| **Headless image** (Docker / the same bundle + `cortex start`) | For a home server, NAS or a small VPS that stays on. Same brain, same dashboard over the network (put TLS in front). | The customer, wherever they like (docs/SELF_HOSTING.md) |
| **Setup prompt** (docs/SETUP_WITH_AN_AGENT.md) | Paste into any coding agent; it installs, asks for keys, runs `cortex doctor` until green, starts the service. | The customer's own agent |
| **Community hub** | Signed track records, leaderboard, follow other agents, memory packs. | **Us** (one Worker + D1; no keys, no orders) |
| **License + updates** | Signed licence file checked offline; signed update feed from GitHub releases (ADR-077). | Us (built; needs the publisher keys, see below) |

## Why not host it for them, or deploy into their cloud

- **Hosting every customer's brain** (SaaS) means holding their broker keys and running their trading: liability,
  security burden, and in many places regulated activity. It also costs us money per customer.
- **GitHub Actions per customer** needs our source in their repo (or ours running their jobs): neither works closed.
- **Deploying into their Cloudflare account** (`cortex deploy`) uploads the worker bundle to an account they own, so
  they can download it. It stays as an *advanced, documented* option for technical buyers, not the default path.
- **On their machine** the code is also on their machine. Minified bundles plus a license check raise the bar; the
  real moat is the hub, the community, the steady stream of updates and the research quality, not secrecy.

## Always-on without our servers

1. Leave the desktop app running (it hides to the tray; the brain keeps pulsing), or
2. run the headless image on anything that's always on (a $5 VPS, a Raspberry Pi 5, a NAS), or
3. advanced: `cortex deploy` to their own Cloudflare account; their desktop becomes the research runner.

## What's in each install today

- `cortex` CLI and the background service: built and tested (ADR-064).
- Desktop app: built and launch-tested on macOS arm64 (ADR-066). Every merge to main builds macOS (arm64, x86_64),
  Windows x86_64 and Linux (x86_64, arm64) installers and publishes a release with a generated changelog
  (`.github/workflows/release.yml`, ADR-077).
- Docker image: written; not run in a container yet.
- Hub: built and tested in-process (ADR-068); not deployed (needs a D1 id and a domain).

## The commercial layer (ADR-077)

- **Licensing (built):** an Ed25519-signed licence file, checked offline against the publisher key baked into the
  build (`CORTEX_LICENSE_PUBKEY` repository variable; `tsx scripts/license.ts keygen | issue`). A storefront (Gumroad,
  Lemon Squeezy) only has to email the file. Without a valid licence demo mode works and paper mode holds new entries
  (open positions keep their stops); nothing unsafe follows from a licence problem. Unset key = builds that never check.
- **Signed auto-updates (built):** Tauri's updater reads `latest.json` from the latest GitHub release; bundles are
  signed with the minisign key in `TAURI_SIGNING_PRIVATE_KEY` (repository secret). The tray offers each update.
- **Demo cockpit (built):** `pnpm web:demo` → static files on synthetic data, attached to every release and on Pages.
- **MSIX (built, ADR-079):** every release has an unsigned MSIX for Windows 11 (`Add-AppxPackage -AllowUnsigned`);
  for the Microsoft Store, set `MSIX_PUBLISHER` / `MSIX_NAME` from Partner Center and the Store signs it.
- **Apple notarization (wired, ADR-079):** add the six `APPLE_*` secrets (Developer ID certificate + notarization
  login) and releases come out signed and notarized. Needs an Apple Developer account.
- **Not planned: a Windows code-signing certificate** (operator decision); SmartScreen asks once on the installers.
- **Demo cockpit:** https://x-thefox.github.io/Cortex-54/ (GitHub Pages, every release).
- **The repo going private:** when it does, GitHub Actions minutes stop being free; the operator's own deployment
  should switch to `RUNNER_MODE=queue` with a desktop runner (ADR-065), which needs no Actions at all.
