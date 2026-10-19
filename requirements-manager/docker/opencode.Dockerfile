FROM node:22-bookworm
ARG TARGETARCH
WORKDIR /plugin
RUN case "$TARGETARCH" in \
      amd64) OPENCODE_PLATFORM_PACKAGE=opencode-linux-x64 ;; \
      arm64) OPENCODE_PLATFORM_PACKAGE=opencode-linux-arm64 ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && npm install -g bun@1.3.6 "${OPENCODE_PLATFORM_PACKAGE}@1.18.18" opencode-ai@1.18.18
COPY package.json bun.lock ./
RUN bun install --ignore-scripts
COPY src src
COPY scripts/verify-node-runner.mjs scripts/verify-node-runner.mjs
COPY skills skills
COPY templates templates
COPY standards standards
RUN bun run build
RUN mkdir -p /root/.config/opencode && printf '{"$schema":"https://opencode.ai/config.json","model":"deepseek/deepseek-v4-flash","plugin":["file:///plugin/dist/index.js"]}\n' > /root/.config/opencode/opencode.json
COPY requirements-manager/docker/opencode-entrypoint.sh /usr/local/bin/opencode-entrypoint
COPY requirements-manager/docker/opencode-healthcheck.mjs /usr/local/bin/opencode-healthcheck.mjs
RUN chmod +x /usr/local/bin/opencode-entrypoint
WORKDIR /data/projects
ENTRYPOINT ["/usr/local/bin/opencode-entrypoint"]
