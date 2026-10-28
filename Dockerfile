# Savant headless (ADR-066): the same local brain as the desktop app, for a home server, NAS or VPS.
# Build the bundle first: pnpm cortexd:build   then: docker build -t cortex54 .
# Run:   docker run -d --name cortex54 -v cortex54:/data -p 127.0.0.1:8754:8754 cortex54
# Setup: docker exec -it cortex54 savant setup        (keys live in the /data volume, mode 600)
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
WORKDIR /app
COPY dist/cortexd/ /app/
RUN printf '#!/bin/sh\nexec node /app/cortexd.mjs "$@"\n' > /usr/local/bin/cortex && chmod +x /usr/local/bin/cortex \
 && useradd --create-home --uid 10001 cortex && mkdir -p /data && chown cortex /data
USER cortex
ENV CORTEX_HOME=/data CORTEX_ROOT=/app
VOLUME ["/data"]
EXPOSE 8754
# first boot: a keyless demo listening on all interfaces inside the container; `savant setup` switches to paper mode
CMD ["sh", "-c", "[ -f /data/config.json ] || savant setup --mode demo --bind 0.0.0.0 --yes; exec savant start"]
HEALTHCHECK --interval=60s --timeout=5s CMD curl -fs http://127.0.0.1:8754/health || exit 1
