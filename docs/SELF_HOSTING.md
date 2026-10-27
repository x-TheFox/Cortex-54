# Self-hosting Savant headless

The same brain as the desktop app, for a machine that's always on. You run it; we never see it.

## Docker

```bash
docker run -d --name cortex54 --restart unless-stopped \
  -v cortex54:/data -p 127.0.0.1:8754:8754 cortex54:latest
docker exec -it cortex54 savant setup          # keys go into the /data volume (mode 600)
docker exec cortex54 savant doctor
docker exec cortex54 savant link               # one-time login link for the dashboard
```

The container listens on all interfaces inside the container; the `-p 127.0.0.1:…` mapping keeps it on the host only.
To reach it from elsewhere, put a TLS reverse proxy in front (Caddy, Tailscale serve, Cloudflare Tunnel) — never
expose the plain HTTP port to the internet.

## Without Docker

Install Node 24 LTS, git and uv, unpack the Savant bundle, then:

```bash
node cortexd.mjs setup --mode paper --bind 127.0.0.1
node cortexd.mjs doctor
node cortexd.mjs service install    # systemd user unit on Linux, launchd on macOS, logon task on Windows
```

## Rules that still apply

- One brain per Alpaca account. Two Savant brains on the same account fight over orders (`doctor` can't detect it).
- The kill switch is `savant kill` (a file in the Savant home); it blocks new entries, positions keep their stops.
- Back up `~/.cortex54` (or the `/data` volume): it holds the journal, the hub identity key and your keys.
