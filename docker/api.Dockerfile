# syntax=docker/dockerfile:1.19
# PortfolioPilot API (milestone 33): Next.js Route Handlers served by the managed server (apps/api/server.mjs,
# bounded graceful drain from milestone 30) on top of Next.js standalone output tracing.
#   docker build -f docker/api.Dockerfile -t portfolio-pilot-api:local .
# Supported platforms: linux/amd64 and linux/arm64 (glibc). See docs/lessons/33-*.md.
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
# Runtime base: Debian slim plus ONLY the node binary from NODE_IMAGE (no npm, npx, corepack or yarn in any layer).
ARG RUNTIME_BASE=debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

# ---------------------------------------------------------------- manifests only (stable cache key)
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/agent/package.json packages/agent/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
COPY packages/providers/package.json packages/providers/

# ---------------------------------------------------------------- full lockfile install and build
FROM manifests AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
# `next build` with output: 'standalone' traces every route, instrumentation and the Next server into
# apps/api/.next/standalone (outputFileTracingRoot = repository root). No .env file is in the context.
RUN for name in contracts domain config providers observability db agent api; do \
      npm run build --workspace=@portfolio-pilot/$name || exit 1; \
    done

# ---------------------------------------------------------------- traced runtime tree
FROM build AS runtime-tree
COPY docker/trace-runtime.mjs docker/trace-runtime.mjs
# Standalone output does not trace a custom server. Next's own server trace already holds the `next`
# runtime that server.mjs imports, so trace only the rest (config/server + zod) and merge it
# without overwriting Next's files; then drop image optimisation (unused here).
RUN cp apps/api/server.mjs apps/api/.next/standalone/apps/api/server.mjs \
 && node docker/trace-runtime.mjs --base /src --out /src/apps/api/.next/standalone --skip-existing --entry apps/api/server.mjs --ignore node_modules/next/ \
 && rm -rf apps/api/.next/standalone/apps/api/server.js apps/api/.next/standalone/node_modules/sharp apps/api/.next/standalone/node_modules/@img \
 && test -x "$(find apps/api/.next/standalone/node_modules/@anthropic-ai -path '*claude-agent-sdk-linux-*/claude' | head -1)"

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS node

FROM ${RUNTIME_BASE} AS runtime
# tini is PID 1: it forwards SIGTERM/SIGINT to Node (which drains) and reaps orphaned children of the
# Claude Code subprocess (live article analysis). ca-certificates: system trust store for TLS clients.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log \
 && groupadd --system --gid 10001 portfolio \
 && useradd --system --uid 10001 --gid portfolio --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin portfolio \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/portfolio-pilot/agent-workspace /var/lib/portfolio-pilot/home
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# Application code is owned by root and read-only to the runtime user.
COPY --from=runtime-tree /src/apps/api/.next/standalone/ /app/
WORKDIR /app/apps/api

# Production is the default; the local demo profile must opt out explicitly (and stays loopback-only).
# Writable state lives ONLY under /var/lib/portfolio-pilot and /tmp; mount the root filesystem read-only.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    API_HOSTNAME=0.0.0.0 \
    AGENT_WORKSPACE_DIR=/var/lib/portfolio-pilot/agent-workspace \
    HOME=/var/lib/portfolio-pilot/home \
    TMPDIR=/tmp
USER 10001:10001
# Gate: the SDK's own native CLI resolves for this CPU/libc and starts as the runtime user.
RUN --mount=type=bind,source=docker/check-sdk-runtime.mjs,target=/tmp/check-sdk-runtime.mjs \
    node /tmp/check-sdk-runtime.mjs /app/apps/api
EXPOSE 3001
STOPSIGNAL SIGTERM
# Liveness only: readiness (/api/health/ready) depends on PostgreSQL/Redis and belongs to the router.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
