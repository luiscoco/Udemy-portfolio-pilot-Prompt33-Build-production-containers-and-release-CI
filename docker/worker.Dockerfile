# syntax=docker/dockerfile:1.19
# PortfolioPilot worker (milestone 33): one image, roles selected at run time with WORKER_ROLE
# (ingestion | outbox | agent). Build from the repository root:
#   docker build -f docker/worker.Dockerfile -t portfolio-pilot-worker:local .
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
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# Lifecycle scripts stay disabled (supply-chain hygiene, as in local installs); nothing here needs one.
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
# Dependency order; `db` runs `prisma generate` (prisma-client generator, TypeScript output, no engine binary).
RUN for name in contracts domain config providers observability db agent worker; do \
      npm run build --workspace=@portfolio-pilot/$name || exit 1; \
    done

# ---------------------------------------------------------------- traced runtime tree
FROM build AS runtime-tree
COPY docker/trace-runtime.mjs docker/trace-runtime.mjs
# Entry points: the worker (all roles), the audited admin CLI (milestone 30) and the guarded demo
# seed (local profile only). Skills are read at run time; the SDK's native CLI is resolved dynamically.
RUN node docker/trace-runtime.mjs --base /src --out /out \
      --entry apps/worker/dist/index.js --entry apps/worker/dist/admin.js --entry packages/db/dist/seed-cli.js \
      --include packages/agent/runtime --sdk-native

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS node

FROM ${RUNTIME_BASE} AS runtime
# tini is PID 1: it forwards SIGTERM/SIGINT to Node (which drains) and reaps any orphaned children of
# the Claude Code subprocess. ca-certificates: system trust store for TLS clients.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log \
 && groupadd --system --gid 10001 portfolio \
 && useradd --system --uid 10001 --gid portfolio --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin portfolio \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/portfolio-pilot/agent-workspace /var/lib/portfolio-pilot/session-artifacts /var/lib/portfolio-pilot/home
WORKDIR /app
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# Application code is owned by root and read-only to the runtime user.
COPY --from=runtime-tree /out/ /app/

# Production is the default; the local demo profile must opt out explicitly (and stays loopback-only).
# Writable state lives ONLY under /var/lib/portfolio-pilot and /tmp; mount the root filesystem read-only.
ENV NODE_ENV=production \
    WORKER_ROLE=ingestion \
    WORKER_HEALTH_PORT=8081 \
    WORKER_HEALTH_HOST=127.0.0.1 \
    AGENT_WORKSPACE_DIR=/var/lib/portfolio-pilot/agent-workspace \
    SESSION_ARTIFACT_DIR=/var/lib/portfolio-pilot/session-artifacts \
    HOME=/var/lib/portfolio-pilot/home \
    TMPDIR=/tmp
USER 10001:10001
# Gate: the SDK's own native CLI resolves for this CPU/libc and starts as the runtime user.
RUN --mount=type=bind,source=docker/check-sdk-runtime.mjs,target=/tmp/check-sdk-runtime.mjs \
    node /tmp/check-sdk-runtime.mjs /app/packages/agent
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.WORKER_HEALTH_PORT+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/worker/dist/index.js"]
