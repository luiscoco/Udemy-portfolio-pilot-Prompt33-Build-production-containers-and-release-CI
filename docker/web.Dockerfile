# syntax=docker/dockerfile:1.19
# PortfolioPilot web (milestone 33): the static React/Vite build behind unprivileged nginx with SPA
# fallback and the /api reverse proxy (docker/nginx/default.conf.template).
#   docker build -f docker/web.Dockerfile -t portfolio-pilot-web:local .
# Supported platforms: linux/amd64 and linux/arm64. The bundle itself is platform-independent.
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e

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

# ---------------------------------------------------------------- browser build
FROM manifests AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts
COPY tsconfig.base.json ./
# Only browser-safe workspaces enter this stage: server packages cannot leak into the bundle.
COPY packages/contracts packages/contracts
COPY packages/config packages/config
COPY apps/web apps/web
RUN for name in contracts config web; do npm run build --workspace=@portfolio-pilot/$name || exit 1; done \
 && find apps/web/dist -name '*.map' -delete

# ---------------------------------------------------------------- runtime (nginx, uid 101, port 8080)
FROM ${NGINX_IMAGE} AS runtime
COPY --chown=root:root docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --chown=root:root docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build --chown=root:root /src/apps/web/dist /usr/share/nginx/html
USER root
# The stock site config is replaced by the rendered template. Rendered config and nginx temp files go to
# /etc/nginx/conf.d and /tmp, the only writable paths when the root filesystem is read-only.
RUN rm -f /etc/nginx/conf.d/default.conf
USER 101:101
ENV API_UPSTREAM=api:3001 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENTRYPOINT_QUIET_LOGS=1
EXPOSE 8080
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
