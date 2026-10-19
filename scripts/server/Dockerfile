# syntax=docker/dockerfile:1
# Matrix Agent — Multi-stage Docker build
#
# Stage 1: Build the TypeScript plugin with Bun
# Stage 2: Runtime image with Bun, OpenCode, ripgrep, Python (docxtpl + stdlib), and the plugin
#
# Build context: repository root (version must match scripts/pack-docker.sh and .env.example MATRIX_VERSION)
#   docker build --network=host -f scripts/server/Dockerfile \
#     --build-arg MATRIX_AGENT_VERSION=0.2.17 \
#     -t matrix-agent:0.2.17 -t matrix-agent:latest .
#
# Required build-time directory:
#   tools-archive/runtime/linux/  — must contain: bun, opencode, rg binaries

# ── Stage 1: build plugin ────────────────────────────────────────────────────
FROM oven/bun:1-debian AS build
WORKDIR /build
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src/ src/
COPY tsconfig.json .
RUN bun run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# System packages — single layer, clean up immediately
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini git curl ca-certificates libarchive-tools locales \
        unrar-free \
        python3 python3-pip python3-venv && \
    sed -i '/^#\s*en_US.UTF-8/s/^#\s*//' /etc/locale.gen && \
    sed -i '/^#\s*zh_CN.UTF-8/s/^#\s*//' /etc/locale.gen && \
    locale-gen && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Lightweight Python deps shared with the offline tools-archive Python payload.
COPY tools-archive-requirements.txt /tmp/tools-archive-requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install --break-system-packages --timeout=300 -r /tmp/tools-archive-requirements.txt && \
    python3 -c "import docxtpl; print('OK: docxtpl')" && \
    rm -f /tmp/tools-archive-requirements.txt && \
    (find /usr/local/lib/python3* /usr/lib/python3* -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true)

ENV MATRIX_PYTHON=/usr/bin/python3

# Directory layout
RUN mkdir -p /opt/matrix/runtime \
             /opt/matrix/plugin/dist \
             /opt/matrix/server \
             /opt/matrix/run \
             /opt/matrix/nginx.d \
             /data/matrix-projects

# ── Runtime binaries (bun, opencode, rg) from tools-archive ─────────────────
COPY tools-archive/runtime/linux/ /opt/matrix/runtime/
RUN chmod +x /opt/matrix/runtime/*

# ── Plugin from build stage ──────────────────────────────────────────────────
COPY --from=build /build/dist/ /opt/matrix/plugin/dist/
COPY skills/       /opt/matrix/plugin/skills/
COPY templates/    /opt/matrix/plugin/templates/
COPY standards/    /opt/matrix/plugin/standards/
COPY bin/          /opt/matrix/plugin/bin/
COPY node_modules/ /opt/matrix/plugin/node_modules/
COPY package.json  /opt/matrix/plugin/package.json

# ── Manager server (last — changes most often, maximizes cache reuse) ────────
COPY scripts/server/manager.ts /opt/matrix/server/

# ── PATH & entrypoint ──────────────────────────────────────────────────────
# Keep default in sync with scripts/pack-docker.sh VERSION / MATRIX_VERSION in .env.example
ARG MATRIX_AGENT_VERSION=0.2.17
LABEL org.opencontainers.image.version="${MATRIX_AGENT_VERSION}"

ENV PATH="/opt/matrix/runtime:$PATH"

ENTRYPOINT ["tini", "--"]
CMD ["/opt/matrix/runtime/bun", "run", "/opt/matrix/server/manager.ts"]
