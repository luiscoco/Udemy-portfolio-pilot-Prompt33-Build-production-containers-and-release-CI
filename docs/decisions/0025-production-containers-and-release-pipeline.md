# 0025. Production containers and release pipeline

- Status: Accepted
- Date: 2026-10-03
- Milestone: 33

## Context

Milestones 34–35 deploy PortfolioPilot to AKS. That needs images for four roles: the static React
frontend, the Next.js API, the worker (ingestion, outbox and agent roles), and a one-shot database
migration. The images must be small, reproducible and free of secrets, and they must run as non-root
on a read-only root filesystem. They also need a CI pipeline that cannot publish or deploy without a
human decision.

Verified facts that shaped the design (2026-10-03, on this repository's pinned versions):

- **Claude Agent SDK 0.3.276** ships Claude Code 2.1.276 as a native executable (`claude`, about
  221 MB on linux-x64). It lives in optional per-platform packages (`claude-agent-sdk-linux-x64`,
  `-linux-arm64`, the `-musl` variants, darwin and win32). `sdk.mjs` resolves
  `@anthropic-ai/claude-agent-sdk-linux-<arch>[-musl]/claude` relative to itself at run time and
  prefers glibc on glibc hosts. The lockfile records `cpu` and `libc` for each package, so `npm ci`
  installs only the matching one. No static tracer can see this dynamic resolution.
- **The API also needs the SDK binary.** In Claude mode it constructs `ClaudeArticleAnalyzer`
  (on-demand article analysis), not just the worker.
- **Next.js 16.3.8** (`node_modules/next/dist/docs`, `output.md` and `custom-server.md`):
  - `output: 'standalone'` copies only traced files.
  - `outputFileTracingRoot` must point at the monorepo root.
  - `outputFileTracingIncludes` adds files that tracing misses, but route excludes do not apply to
    Next's own server trace.
  - Standalone output "does not trace custom server files". Milestone 30, however, requires the
    managed `apps/api/server.mjs` for a bounded drain.
- The generated standalone `server.js` passes the build's serialized configuration through
  `__NEXT_PRIVATE_STANDALONE_CONFIG`. `.next/required-server-files.json` holds the same config
  (compared field by field: equal except the normalized `distDir`).
- **Workspace devDependencies survive `npm ci --omit=dev`.** In this workspace the lockfile marks
  `typescript`, `vite`, `vitest` and `prisma` as `devOptional` (optional peers of runtime packages),
  so `--omit=dev` keeps them (measured: 679 MB with or without a `--workspace` filter). Omitting
  optional dependencies as well would remove the SDK's native CLI.
- **Prisma 7.10.0** with the `prisma-client` generator emits TypeScript and runs on the query-compiler
  WASM runtime, so the application images need no engine binary. `migrate deploy` needs the Rust schema
  engine, which `prisma generate` downloads at build time (`schema-engine-debian-openssl-3.0.x` on
  amd64).
- The `node:24.21.0-trixie-slim` image has **no CA bundle**. Node and the Claude CLI carry their own
  roots, but the schema engine verifies PostgreSQL TLS against the system store.

## Decision

### Images (all multi-stage, one Dockerfile per role under `docker/`)

| Image | Runtime base | User | Contents |
| --- | --- | --- | --- |
| `portfolio-pilot-web` | `nginxinc/nginx-unprivileged:1.30.5-alpine` | 101 | Vite build (no source maps) and the nginx template |
| `portfolio-pilot-api` | `debian:trixie-slim` + Node binary | 10001 | Next standalone tree and the traced dependencies of `server.mjs` |
| `portfolio-pilot-worker` | `debian:trixie-slim` + Node binary | 10001 | Traced worker, admin CLI and guarded demo seed |
| `portfolio-pilot-migrate` | `debian:trixie-slim` + Node binary | 10001 | Traced Prisma CLI, migrations and one schema engine |

1. **Stages.** Each Dockerfile has these stages:
   - `manifests`: the lockfile and every workspace `package.json`, as a stable cache key.
   - `build`: `npm ci --ignore-scripts`, then building only the workspaces the role needs.
   - A traced runtime tree.
   - `runtime`.

   The build context is an allowlist (`.dockerignore`). It excludes `.env*`, agent settings and
   instruction files, `.local` session artifacts, host build output, tests and the test-only
   `apps/api/lib/testing`. The web build stage receives only the browser-safe workspaces.
2. **Runtime base.** Base images are pinned by tag and digest. The Node runtimes copy **only** the
   `node` binary from the pinned Node image onto Debian slim, so npm, npx, corepack and yarn are absent
   from every layer. Debian adds only `tini` (PID 1: forwards signals and reaps the CLI's children) and
   `ca-certificates`.
3. **Exact dependency packaging by tracing** with `@vercel/nft` 1.11.0, the tracer behind Next output
   tracing (`docker/trace-runtime.mjs`):
   - **API.** Next standalone output, plus an `outputFileTracingIncludes` glob for the SDK's
     `claude-agent-sdk-linux-*` package. `server.mjs` is traced and merged into the tree without
     overwriting Next's files, with `next/` left to Next's own server trace. `sharp` is removed
     (image optimisation is unused).
   - **Worker.** Its entry points are traced, plus `packages/agent/runtime` (skills read at run time)
     and the SDK native package, resolved the way the SDK resolves it (`--sdk-native`).
   - **Migrate.** The Prisma CLI entry and `prisma/config` are traced, plus the migrations and the single
     schema engine for the build platform.

   Type declarations, source maps, `.env*` and agent files are never copied.
4. **Custom server on the standalone tree.** `server.mjs` sets `__NEXT_PRIVATE_STANDALONE_CONFIG` from
   `.next/required-server-files.json`, exactly as Next's generated server does. It does this in both the
   repository and image layouts, so both run the configuration that was built. The generated `server.js`
   is deleted from the image.
5. **SDK runtime gate.**
   - Every API and worker build runs `docker/check-sdk-runtime.mjs` as the runtime user. It resolves
     the native CLI like the SDK, checks that its version matches the SDK pin, and executes
     `claude --version`.
   - `docker/verify/sdk-fixture-probe.mjs` (bind-mounted, never baked) completes a real SDK turn
     against a loopback HTTP model fixture. The container has a read-only root, no capabilities and
     `--network none`.
6. **Writable state is separate from code.** Application files are root-owned and read-only to uid
   10001, and the root filesystem is mounted read-only. Only three paths are writable:
   - `/var/lib/portfolio-pilot/agent-workspace` (SDK `CLAUDE_CONFIG_DIR` and `cwd`): ephemeral, a
     tmpfs or `emptyDir`.
   - `/var/lib/portfolio-pilot/session-artifacts`: persistent; local backend only (Blob in Azure,
     milestone 28).
   - `/tmp`.

   `HOME` points to a non-writable directory. The fixture probe confirmed that the CLI writes only to
   the workspace (`.claude.json` and `projects/<cwd>/<id>.jsonl`).
7. **Production by default.** Images set `NODE_ENV=production`, so the server configuration demands
   HTTPS, Entra, `AUTH_SECRET` and `DATABASE_URL`, and refuses demo authentication. The production-like
   Compose file opts into the local demo profile explicitly. That profile still requires a loopback
   origin.
8. **Signals and health.**
   - Node images stop with SIGTERM and run the milestone-30 drains. Compose stop grace periods
     (30 s for the API, 35 s for workers) exceed `API_SHUTDOWN_GRACE_MS` and
     `WORKER_SHUTDOWN_GRACE_MS`.
   - nginx stops with SIGQUIT (graceful).
   - `HEALTHCHECK`s cover liveness only: API `/api/health/live`, the worker's loopback
     `/health/ready` on 8081, and web `/healthz`. Dependency readiness belongs to the router and
     Kubernetes probes (milestone 35).
9. **Web server.**
   - SPA fallback to `index.html`, revalidated on every request (`no-cache`).
   - Hashed `/assets/` are cached as `immutable`, but only on success. Any missing file is a 404,
     never HTML.
   - `/api/` is reverse-proxied with `proxy_buffering off` and one-hour read timeouts for SSE. The API
     also sends `X-Accel-Buffering: no`.
   - `X-Forwarded-For` is replaced, not appended.
   - nginx's own 502s use the application's JSON error shape.
   - A strict CSP (the build has no inline script or style).
   - The upstream is re-resolved through the entrypoint's local resolvers.
10. **Release CI** (`.github/workflows/`). Actions are pinned to commit SHAs.
    - `ci.yml`: install from the lockfile; build, typecheck, lint, boundary, unit tests and the mock
      evaluation; the integration and browser suites; amd64 images that are scanned (with the
      scanner self-test) and smoke-tested; native arm64 image builds.
    - `release.yml` publishes and deploys, and runs only when **all** of these hold:
      - it is started manually, from `main`, with `vars.RELEASE_ENABLED == 'true'`;
      - the jobs pass GitHub environments `release-registry` and `production`, which are configured
        with required reviewers;
      - authentication is Azure OIDC workload identity federation (`id-token: write`, then
        `azure/login`, then `az acr login`).

      There are no stored client secrets, registry passwords or kubeconfigs. Images are pushed by
      digest per native architecture, merged under the commit SHA (never `latest`), and given SLSA
      provenance and SBOM attestations. The deploy job confirms the digests and then stops; the
      rollout steps arrive in milestone 35.

### Supported platforms and SDK constraints

- **linux/amd64 (glibc): verified.** Built, gated, fixture-probed, smoke-tested and scanned on this
  workstation.
- **linux/arm64 (glibc): supported by construction, not verified locally.**
  - The lockfile holds the SDK linux-arm64, Next swc arm64-gnu and rolldown/lightningcss arm64-gnu
    packages, and Prisma fetches the arm64 schema engine at build time.
  - CI builds arm64 natively on `ubuntu-24.04-arm`, where the build gate executes the arm64 CLI.
  - This Docker Desktop has no arm64 emulation, so it was not built here.
- **musl/Alpine is not supported** for the Node images. The SDK prefers glibc, the musl CLI is untested
  here, and the size win is negligible next to the 221 MB CLI.
- **Not supported:** Windows containers and 32-bit or other architectures.
- **SDK constraints.**
  - The native CLI must match the image's CPU and libc. It is installed from the lockfile, never
    globally, and never downloaded at run time.
  - It needs a writable `CLAUDE_CONFIG_DIR`.
  - Its version is tied to the SDK pin (0.3.276 ⇒ 2.1.276); upgrading the SDK means rebuilding the
    images and rerunning the gate.

## Alternatives considered

- **`npm ci --omit=dev` (optionally with `--workspace`).** Kept build tools (`devOptional`), measured
  at 679 MB versus a 245 MB traced tree.
- **Next's generated standalone `server.js` or `next start`.** Both lose the milestone-30 bounded drain
  and the explicit "not processed" 503 that the gateway contract depends on.
- **Distroless Node.** Its Node version follows the distroless release cadence rather than our
  24.21.0 pin, and it has no `tini` or shell for health checks and diagnostics. Debian slim plus
  one copied binary achieves the same absence of npm.
- **Alpine/musl.** Rejected for the reasons in the platform section above.
- **Removing npm with `rm` in the runtime stage.** The first iteration did this. The layer scan
  showed the files still shipping in the base layers, which led to the rebased runtime.
- **One multi-target Dockerfile.** Per-role files read more clearly in a teaching repository. Each
  builds only the workspaces it needs, and BuildKit caches the identical stages anyway.
- **QEMU for arm64.** Slow, and it emulates exactly the native binary we want to exercise; native
  runners exist.
- **Service-principal secrets or ACR admin credentials in CI.** Long-lived and copyable. OIDC tokens
  are short-lived, and the federated credential is bound to the environment.

## Consequences

- **Compressed image sizes:** web 22 MB, API 184 MB, worker 180 MB, migrate 106 MB. The CLI
  (221 MiB raw, about 97 MiB gzip-compressed) is more than half of each of the API and worker images.
- **Dependence on Next.js internals.** `server.mjs` relies on the undocumented
  `__NEXT_PRIVATE_STANDALONE_CONFIG`, and the image relies on the standalone layout. Any Next upgrade
  must rerun `npm run verify:containers`, which detects a break as an API that is not healthy.
- **Prisma advisories in the migrate image.** It ships the Prisma CLI tree, which carries the four
  `npm audit` advisories noted in milestone 32 (`deepmerge-ts`, `mysql2`). `mysql2` is unused with
  PostgreSQL, and the job is short-lived and runs no untrusted input. The API and worker images do not
  contain these packages.
- **Demo seeding stays loopback-only.** The seed's guard is unchanged, so the Compose demo seed joins
  PostgreSQL's network namespace to connect over 127.0.0.1.
- **Signals that this decision is wrong:**
  - the smoke test or SDK gate failing after a dependency bump;
  - the trace reporting new unresolved warnings;
  - CI arm64 builds failing on the native CLI;
  - the image scan reporting findings.

## References

Checked 2026-10-03:

- Next.js 16.3.8 bundled docs: `01-app/03-api-reference/05-config/01-next-config-js/output.md`
  and `01-app/02-guides/custom-server.md`.
- `next/dist/build/utils.js` (`copyTracedFiles` and the generated server template).
- `@anthropic-ai/claude-agent-sdk` 0.3.276: `package.json` `optionalDependencies` and
  `claudeCodeVersion`; native resolution in `sdk.mjs`.
- `@vercel/nft` 1.11.0 (npm `latest`).
- Prisma 7.10.0 `prisma --version` output (Query Compiler enabled; schema engine path).
- Docker Hub digests for `node:24.21.0-trixie-slim`, `debian:trixie-slim` and
  `nginxinc/nginx-unprivileged:1.30.5-alpine`; nginx-unprivileged entrypoint (envsubst templates,
  `NGINX_ENTRYPOINT_LOCAL_RESOLVERS`).
- GitHub Actions `action.yml` inputs at the pinned SHAs: checkout v7.0.1, setup-node v7.0.0,
  build-push-action v7.4.0, setup-buildx-action v4.4.1, upload-artifact v7.0.1, download-artifact
  v8.0.1, azure/login v3.1.0 and attest-build-provenance v4.2.2.
- actionlint 1.7.12.
