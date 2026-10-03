# syntax=docker/dockerfile:1.19
# PortfolioPilot database migration job (milestone 33): `prisma migrate deploy` with the pinned Prisma CLI,
# the committed migrations and the schema engine fetched at BUILD time (nothing is downloaded at run
# time). Runs once before an application rollout (Compose `migrate` service; Kubernetes Job in 35).
#   docker build -f docker/migrate.Dockerfile -t portfolio-pilot-migrate:local .
# Supported platforms: linux/amd64 and linux/arm64 (glibc, OpenSSL 3).
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
# Runtime base: Debian slim plus ONLY the node binary from NODE_IMAGE (no npm, npx, corepack or yarn in any layer).
ARG RUNTIME_BASE=debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

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

FROM manifests AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false CHECKPOINT_DISABLE=1
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts
COPY packages/db/prisma.config.ts packages/db/prisma.config.ts
COPY packages/db/prisma packages/db/prisma
COPY docker/trace-runtime.mjs docker/trace-runtime.mjs
# `prisma generate` fetches the schema engine for this platform (lifecycle scripts are disabled), then the
# CLI, its config entry and that one engine are traced into /out.
RUN npm run generate --workspace=@portfolio-pilot/db \
 && set -- node_modules/@prisma/engines/schema-engine-* && test "$#" -eq 1 && test -x "$1" \
 && node docker/trace-runtime.mjs --base /src --out /out \
      --entry node_modules/prisma/build/index.js --entry node_modules/prisma/config.js \
      --include packages/db/prisma --include "$1" \
 && cp packages/db/package.json packages/db/prisma.config.ts /out/packages/db/

FROM ${NODE_IMAGE} AS node

FROM ${RUNTIME_BASE} AS runtime
# tini forwards signals; ca-certificates: the Rust schema engine verifies PostgreSQL TLS with the system store.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log \
 && groupadd --system --gid 10001 portfolio \
 && useradd --system --uid 10001 --gid portfolio --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin portfolio
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /out/ /app/
WORKDIR /app/packages/db
ENV NODE_ENV=production CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 HOME=/tmp TMPDIR=/tmp
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
# prisma.config.ts has a local-development fallback URL; a release job must never fall back to it.
CMD ["sh", "-c", "test -n \"$DATABASE_URL\" || { echo 'DATABASE_URL is required' >&2; exit 2; }; exec node /app/node_modules/prisma/build/index.js migrate deploy"]
