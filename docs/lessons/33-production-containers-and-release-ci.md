# 33. Build production containers and release CI

Decision record: [ADR 0025](../decisions/0025-production-containers-and-release-pipeline.md).

## What works

- **Four release images**, each built from the committed lockfile by a multi-stage Dockerfile in
  `docker/`:

  | Image | Contents | User | Compressed |
  | --- | --- | --- | --- |
  | `portfolio-pilot-web` | nginx serving the React build, SPA fallback and the `/api` proxy | 101 | 22 MB |
  | `portfolio-pilot-api` | Next.js standalone output and the managed `server.mjs` | 10001 | 184 MB |
  | `portfolio-pilot-worker` | ingestion, outbox and agent roles via `WORKER_ROLE`, admin CLI, guarded demo seed | 10001 | 180 MB |
  | `portfolio-pilot-migrate` | `prisma migrate deploy` with the build-time schema engine | 10001 | 106 MB |

- **No global developer CLI.** The Claude Code CLI that the Agent SDK drives is the pinned SDK's own
  native package. Every API and worker build runs it as the runtime user, and a probe completes a real
  SDK turn inside both images against a local HTTP fixture, with no network.
- **A production-like Compose stack** (`compose.production.yaml`) with a single origin at
  http://localhost:8080. It runs read-only root filesystems, drops every capability, mocks the
  external services, and runs a migration job and a demo seed before the app starts.
- **`npm run verify:containers`** builds the stack, starts it and proves eight things, then removes it.
  See [The smoke test](#the-smoke-test).
- **`npm run inspect:images`** reads every layer of all four images and fails on secrets, `.env`
  files, transcripts, session artifacts, agent settings, or server references in browser assets.
  `--self-test` plants each violation in a canary image and requires every one to be found.
- **GitHub Actions.**
  - `ci.yml` installs from the lockfile, runs every check and test suite, then builds, scans and
    smoke-tests the amd64 images and builds arm64 natively.
  - `release.yml` publishes and deploys. It is off until enabled, and every job that touches Azure
    sits behind an approved environment and OIDC.
  - **Nothing was pushed or deployed.**

## Part 1: Packaging a monorepo for production

### Why not just `npm ci --omit=dev`?

The usual recipe failed here, and it is worth seeing why. In this workspace `typescript`, `vite`,
`vitest` and the `prisma` CLI are *optional peer dependencies* of runtime packages. The lockfile
therefore marks them `devOptional`, and npm keeps them under `--omit=dev`:

```text
omit-dev-all:       typescript vite vitest prisma next react ...   1.1G
omit-dev-ws (worker): typescript vite vitest prisma react ...      679M
```

Adding `--omit=optional` would delete them, but it would also delete the Agent SDK's native CLI, which
is an optional dependency selected per platform. So the images **trace** what each entry point can
load instead. They use `@vercel/nft`, the same tracer behind Next.js output tracing
(`docker/trace-runtime.mjs`):

```text
worker trace: 2069 files, 238.5 MB
  claude-agent-sdk-linux-x64 = 221.3 MB, zod = 7.5 MB, @prisma/client = 4.6 MB, ...
```

The trace gets help in a few places:

- **`--include`** for files read by path at run time: skills (`packages/agent/runtime`) and the Prisma
  migrations.
- **`--sdk-native`** for the CLI package. The SDK resolves `claude-agent-sdk-linux-<arch>[-musl]/claude`
  dynamically, so the script resolves it the same way.
- **`--ignore node_modules/next/`** for the API, where Next's own server trace already owns `next`.
  Without it, tracing `server.mjs` pulled in 27 MB of Next dev bundles that Next deliberately excludes.

### Next.js standalone output plus a custom server

`next.config.mjs` now sets these options:

```js
output: 'standalone',
outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),   // monorepo root
outputFileTracingIncludes: { '/*': ['../../node_modules/@anthropic-ai/claude-agent-sdk-linux-*/**/*'] }
```

Next's documentation warns that standalone output "does not trace custom server files". Milestone
30's `server.mjs` is that custom server, and it carries the bounded drain the gateway relies on. The
API image therefore does three things:

1. Traces `server.mjs` and merges the result into `.next/standalone` without overwriting Next's
   files. This adds only `@portfolio-pilot/config` and `zod`.
2. Deletes the generated `server.js`, plus `sharp`, which arrives through Next's server trace.
   Route-level excludes don't apply to Next's own server trace.
3. Has `server.mjs` load `.next/required-server-files.json` into `__NEXT_PRIVATE_STANDALONE_CONFIG`,
   exactly what the generated server does. No `next.config.mjs` exists in the image. This was verified
   to equal the generated server's config, apart from `distDir` normalisation.

Treat this as an upgrade checkpoint: the variable is a Next internal. After any Next upgrade, rerun
`npm run verify:containers`.

### Prisma in containers

- **Application images:** the `prisma-client` generator output is compiled into `packages/db/dist`.
  The query-compiler WASM runtime ships inside `@prisma/client`, so no engine binary is needed.
- **Migrate image:** `prisma generate` downloads the schema engine at **build** time; it is not run
  at deploy time. The traced CLI, `prisma.config.ts`, the migrations and that one engine are copied. The
  job refuses to start without `DATABASE_URL`, so it never falls back to the config's local
  development URL.

### The Claude Agent SDK runtime

```text
{"sdk":"0.3.276","claudeCode":"2.1.276","native":"@anthropic-ai/claude-agent-sdk-linux-x64",
 "binary":"/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
 "version":"2.1.276 (Claude Code)","arch":"x64","libc":"glibc"}
```

That is the build gate (`docker/check-sdk-runtime.mjs`) running **as uid 10001** in the final stage.
The fixture probe then completes a turn with the application's isolation options: an isolated
`CLAUDE_CONFIG_DIR`/`cwd`, no setting sources, no built-in tools, and `dontAsk`. It reports where the
CLI wrote:

```text
workspaceFiles: .claude.json, backups/..., projects/-var-lib-portfolio-pilot-agent-workspace/<id>.jsonl, sessions/
```

Everything lands in the workspace tmpfs. The root filesystem is read-only, `HOME` is not writable,
and the probe still succeeds, so the CLI needs no other writable path.

Constraints to remember:

- **Native binary.** The CLI must match the image's CPU and **libc**: glibc here.
- **Build platform.** Building on Windows or macOS works because Docker builds inside a Linux VM, and
  `npm ci` there installs the Linux package.
- **Version pairing.** The SDK version pins the CLI version.

## Part 2: Runtime hardening

| Concern | How |
| --- | --- |
| Non-root | Numeric `USER 10001:10001` (`runAsNonRoot` can verify it); nginx-unprivileged runs as 101 |
| Code cannot be modified | Root-owned files; read-only root filesystem in Compose (and later Kubernetes) |
| Writable state | `/var/lib/portfolio-pilot/agent-workspace` (ephemeral), `/var/lib/portfolio-pilot/session-artifacts` (durable, local backend), `/tmp` |
| Minimal runtime | `debian:trixie-slim` + **only** the `node` binary, `tini`, `ca-certificates`; no npm/npx/corepack/yarn in any layer |
| Signals | `tini` as PID 1 forwards SIGTERM; milestone-30 drains; Compose stop grace greater than the app's drain; nginx `STOPSIGNAL SIGQUIT` |
| Health | Liveness `HEALTHCHECK`s only; readiness (database/Redis) is the router's and Kubernetes' job |
| Capabilities | `cap_drop: [ALL]`, `no-new-privileges` |
| Pinned bases | Tag **and** digest for `node`, `debian`, `nginx-unprivileged` |

Why copy the Node binary instead of deleting npm? The first version ran `rm -rf .../npm` in the
runtime stage, and the layer scan still found npm's files: **deleting a file in a later layer does not
remove it from the image.** Starting from a base that never had them does.

## Part 3: One origin with nginx

`docker/nginx/default.conf.template` is rendered at start (envsubst):

- **`/api/`** is proxied to `API_UPSTREAM` for SSE:
  - `proxy_buffering off` and `proxy_read_timeout 1h`; the API also sends `X-Accel-Buffering: no`.
  - The browser's `Host` is forwarded, and `X-Forwarded-For` is *replaced* rather than appended.
  - nginx's own 502s use the application's JSON error shape. They do not claim "not processed",
    because the request may have reached the API.
- **`/assets/`** is served with `immutable` caching on success only; a missing asset returns a 404.
- **Any other path with an extension** is a file request, so it returns a 404, never `index.html`.
- **Everything else** falls back to the SPA's `index.html` with `Cache-Control: no-cache`.
- **CSP** is `default-src 'self'`, with no inline script or style (the Vite build has none).
- **DNS:** the upstream is re-resolved every 10 s (`server ... resolve`), so a restarted API container
  is found again.

## Part 4: The production-like Compose stack

```bash
# PowerShell: $env:PORTFOLIO_PILOT_AUTH_SECRET = -join ((48..57)+(97..122) | Get-Random -Count 40 | % {[char]$_})
export PORTFOLIO_PILOT_AUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
docker compose -f compose.production.yaml up -d --build --wait
# open http://localhost:8080 and use demo sign-in (alice / bob)
docker compose -f compose.production.yaml down -v
```

Startup order: `postgres`/`redis`, then `migrate` (exits 0), then `seed-demo` (exits 0), then
`api`, `worker-ingestion`, `worker-outbox` and `worker-agent`, then `web`.

Two details worth teaching:

- **The demo profile is explicit.** The images default to `NODE_ENV=production`, where the server
  config refuses demo sign-in and requires HTTPS, Entra, `AUTH_SECRET` and `DATABASE_URL`. Compose opts
  out on purpose, and demo authentication still requires a loopback origin. The smoke test proves the
  production refusal for both images.
- **Guards are not weakened for convenience.** The seed refuses non-loopback databases. Rather than
  relax that, `seed-demo` joins PostgreSQL's network namespace (`network_mode: service:postgres`), so
  it really connects over 127.0.0.1.

`AUTH_SECRET` has no default. With `INSTANCE_ID` set, the API and workers fail closed without one
shared secret.

## The smoke test

`npm run verify:containers` (flags: `-- --skip-build`, `-- --keep`; tag `PORTFOLIO_PILOT_TAG`). These
are the actual results on 2026-10-03:

```text
PASS every app container: non-root, read-only root filesystem, no capabilities, no-new-privileges
PASS application code is read-only; the SDK workspace and session store are writable
PASS single origin: SPA fallback, cache policy, security headers and the /api proxy
PASS trade -> outbox -> Redis -> SSE through nginx
PASS question -> agent worker (mock) -> streamed answer through nginx -> persisted message
PASS bundled Claude Code CLI completes a turn against a local HTTP fixture (API and worker images, no network)
PASS production profile refuses demo authentication (API and worker images)
PASS SIGTERM drains every role and each container exits 0
```

The SSE check asserts that every frame of the run reached the client while the stream was still open.
An earlier draft asserted a minimum time spread between frames. That failed on the app's legitimate
outbox batching, not on proxy buffering, so it tested the wrong thing.

## Part 5: Proving images contain no secrets

`npm run inspect:images` runs `docker save` on each image and streams **every layer**, including files
that a later layer deletes. It checks four things:

- **Paths:**
  - `.env*` files;
  - `.claude`, `.codex` and `.agents` directories, `.claude.json`, `CLAUDE.md` and `AGENTS.md`;
  - Claude Code transcripts (`projects/<cwd>/<uuid>.jsonl`) and session-artifact content;
  - `.git`, `.local`, the npm cache, test output and SSH keys.
- **Content:** real credential *shapes* (Anthropic keys, PEM private key bodies, AWS, GitHub, npm
  auth tokens, Azure account keys, SAS signatures), plus the **literal values** in your local `.env`
  files and secret-named environment variables. Values are never printed.
- **Image config and history:** the user is non-root, and no baked secret-named `ENV` value or secret
  appears in a build step.
- **Browser assets:** no `DATABASE_URL`, `ANTHROPIC`, `AUTH_SECRET`, `postgres://`, Prisma or SDK
  references, and no source maps.

The first run produced false positives, and they are instructive. Next.js, npm's documentation and
the CLI contain the *string* `-----BEGIN PRIVATE KEY-----`, because they detect keys; binary and
base64 data contained random `AKIA…` runs. The rules now require a PEM **body** and token boundaries.
A scanner you have never seen fail proves nothing, so `--self-test` builds a canary with seven planted
violations, one of them a `.env` deleted in a later layer, and requires all seven:

```text
SELF-TEST PASS: all 7 planted violations detected, including a file deleted in a later layer.
PASS: 4 images, no secrets, .env files, transcripts, session artifacts or agent settings; 1 local secret value(s) checked.
```

## Part 6: CI and gated release

`.github/workflows/ci.yml` (on pull requests, `main` and manual runs) has five jobs:

| Job | Runs |
| --- | --- |
| `checks` | `npm ci --ignore-scripts`, build, typecheck, lint, browser boundary, proxy and unit tests, `eval:mock` |
| `integration` | `npm run test:integration` (disposable Docker PostgreSQL/Redis) |
| `browser` | `npm run test:browser` (runner's Chrome; the outage phase owns its containers) |
| `images` | Build the four amd64 images (not pushed), scanner self-test, inspection, containerized smoke test |
| `images-arm64` | Native `ubuntu-24.04-arm` builds; the Dockerfile gate executes the arm64 CLI |

`.github/workflows/release.yml` publishes and deploys. It is designed so that nothing can happen by
accident:

1. It is `workflow_dispatch` only, from `main`, and only when the repository variable
   `RELEASE_ENABLED` is `true`. It is unset, so the workflow does nothing.
2. Jobs use the environments **`release-registry`** (push) and **`production`** (deploy). Configure
   both in GitHub with required reviewers and a `main`-only branch rule. A reviewer must approve before
   any job gets cloud access.
3. **OIDC, not secrets.** `permissions: id-token: write` lets `azure/login` exchange GitHub's
   short-lived token for an Entra token through a federated credential whose subject is
   `repo:<owner>/<repo>:environment:release-registry`. `az acr login` then mints a short-lived registry
   token. The repository stores identifiers only (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID` and `ACR_NAME` as environment *variables*), and no passwords.
4. Images are pushed **by digest** per native architecture and merged into one multi-arch tag, the
   commit SHA (never `latest`). They get provenance and SBOM attestations.
5. `deploy` confirms the digests in ACR and then **stops with an error**: the migration Job and
   rollout arrive in milestone 35.

Workflow hygiene:

- Actions are pinned to commit SHAs.
- Checkout uses `persist-credentials: false`.
- Workflow-level permissions are empty (`release.yml`) or read-only (`ci.yml`).
- There is no `pull_request_target`.
- `actionlint` 1.7.12 reports no issues.

## Supported CPU architectures

| Platform | Status |
| --- | --- |
| linux/amd64 (glibc) | **Verified**: built, gated, fixture-probed, smoke-tested, scanned |
| linux/arm64 (glibc) | **Supported, CI-gated, not verified on this machine**: the lockfile holds the arm64 SDK CLI, Next swc and bundler packages; Prisma fetches the arm64 engine at build. This Docker Desktop has no arm64 emulation (`exec format error`), and enabling it needs a privileged binfmt container, which was not done without authorization |
| musl/Alpine Node images | Not supported (SDK prefers glibc; musl CLI untested) |
| Windows containers, other CPUs | Not supported |

## Teaching points

- **A production image is a list of files you can justify.** Tracing gives that list; `--omit=dev`
  gave 679 MB of guesses.
- **Native binaries make "works on my machine" literal.** The agent runtime is a per-OS/CPU/libc
  executable. Verify it *in the image, as the runtime user*, at build time.
- **Read-only root plus explicit writable paths** tells you exactly where a process writes. An
  unexpected write fails loudly instead of persisting silently.
- **Layers are append-only.** `rm` in a later layer hides a file; it does not remove it.
- **Test the tests.** A scanner with no planted failure, or a timing assertion that measures the wrong
  thing, gives false confidence.
- **Release safety comes from several layers:** manual trigger, an enable variable, required
  reviewers, short-lived OIDC tokens and immutable digests.

## Common mistakes

- Using `next start` or Next's generated `server.js` and silently losing your graceful-drain code.
- Building on the host and copying `node_modules` into a Linux image, which ships the wrong native CLI.
- `COPY . .` without an allowlist `.dockerignore`, so `.env`, `.claude/` or session artifacts reach a
  layer.
- Passing secrets as `ARG`/`ENV`, where they are visible in `docker history` and `docker inspect`.
- Leaving `proxy_buffering on` for SSE, or setting a proxy read timeout shorter than the stream's
  heartbeat interval (15 s here). Either one stalls or cuts long-lived streams.
- Caching a 404 as `immutable`, or serving `index.html` for a missing JavaScript file.
- Storing a cloud client secret in GitHub "because OIDC is complicated".

## Changed files

**Created:**

- `.dockerignore`.
- `docker/web.Dockerfile`, `docker/api.Dockerfile`, `docker/worker.Dockerfile` and
  `docker/migrate.Dockerfile`.
- `docker/trace-runtime.mjs` and `docker/check-sdk-runtime.mjs`.
- `docker/nginx/default.conf.template` and `docker/nginx/security-headers.conf`.
- `docker/verify/sdk-fixture-probe.mjs`.
- `compose.production.yaml`.
- `scripts/verify-containers.mjs` and `scripts/inspect-images.mjs`.
- `.github/workflows/ci.yml` and `.github/workflows/release.yml`.
- `docs/decisions/0025-production-containers-and-release-pipeline.md` and this lesson.

**Modified:**

- `apps/api/next.config.mjs`: standalone output, monorepo tracing root and the SDK native include.
- `apps/api/server.mjs`: loads the serialized build config, so it runs from the standalone tree.
- `package.json`: the `verify:containers` and `inspect:images` scripts, and the `@vercel/nft` 1.11.0
  dev dependency.
- `package-lock.json`: 33 added packages; no existing version changed.
- `docs/versions.md`, `docs/project-state.md`, `docs/verification-report.md`,
  `docs/decisions/README.md` and `.gitignore`.
