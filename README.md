# Production Containers and Release CI

PortfolioPilot is a teaching project: a stock portfolio manager with a live news feed and an AI
assistant built on the Claude Agent SDK. It is built one milestone at a time (36 in total). This
README covers **milestone 33**, which packages the application for production and adds automated
checks (continuous integration) and a release pipeline.

> **Status in one sentence:** the four container images build, pass a full containerized smoke test
> and a secret scan on this machine (linux/amd64). **Nothing was pushed to a registry or deployed**,
> and the GitHub workflows have not run yet.

## Contents

- [Key terms](#key-terms)
- [1. Purpose](#1-purpose)
- [2. Steps performed](#2-steps-performed)
- [3. Results achieved](#3-results-achieved)
- [4. How to run and verify](#4-how-to-run-and-verify)
- [5. Limitations and unfinished work](#5-limitations-and-unfinished-work)
- [Where to read more](#where-to-read-more)

## Key terms

| Term | Meaning |
| --- | --- |
| **Container image** | A packaged, read-only file system plus start command that runs the same way on any machine with Docker. |
| **Layer** | Images are stacks of layers, and each Dockerfile step adds one. A file deleted in a later layer **still ships** inside an earlier one. |
| **Multi-stage build** | A Dockerfile with several stages: a large "build" stage with compilers and dev tools, and a small final stage that copies only what is needed to run. |
| **Non-root user** | The program runs as an ordinary user (here uid `10001`, or `101` for nginx) instead of the all-powerful `root`. |
| **Read-only root filesystem** | The container cannot change its own files, so only explicitly mounted folders are writable. |
| **Output tracing** | Automatically listing exactly which files a program can load. Next.js uses `@vercel/nft` for this, and this milestone uses it for every image. |
| **Claude Code CLI** | The native program that the Claude Agent SDK starts to run the agent. The SDK ships it as a per-platform npm package (for example `claude-agent-sdk-linux-x64`). |
| **SPA fallback** | For a single-page app (SPA), the web server answers unknown paths such as `/portfolios/123` with `index.html` so the React router can handle them. |
| **Reverse proxy** | A server (here nginx) that forwards some requests, here everything under `/api`, to another server. |
| **SSE** | Server-Sent Events: a long-lived HTTP response through which the server pushes live updates. |
| **Smoke test** | A quick end-to-end check that the main paths work in the real packaged system. |
| **CI** | Continuous integration: checks that run automatically on every change (here GitHub Actions). |
| **OIDC** | OpenID Connect. The CI job receives a short-lived identity token and exchanges it for cloud access, so no password or secret is stored. |
| **Environment approval** | A GitHub setting that pauses a job until a named reviewer approves it. |

## 1. Purpose

### What the prompt asked for

Milestone 33 asked the coding agent to:

1. **Create production Dockerfiles** for the static React frontend, the Next.js API and the Node.js
   worker. The work had to check monorepo dependency packaging, Prisma code generation, Next.js
   output tracing and the Claude SDK's native runtime against the pinned versions, without relying
   on a globally installed developer CLI.
2. **Harden the images.** That meant multi-stage builds, non-root users, graceful handling of shutdown
   signals, health checks and minimal runtime dependencies. Writable SDK workspaces had to be kept
   separate from read-only application code.
3. **Run a production-like local setup** in which the web server provides SPA fallback and proxies
   `/api` to the API.
4. **Verify the images.** Build them, run a containerized mock smoke test, and inspect browser assets
   and image layers for `.env` secrets, local transcripts and personal agent settings.
5. **Add CI and a gated release pipeline.** CI covers install, checks, tests and image builds.
   Publishing and deploying must require explicit approval and OIDC, and must not actually run yet.

### Why it matters

Until now the app ran only as local Node processes. Milestones 34–35 deploy to Azure Kubernetes,
which runs **container images**. Images must be small, reproducible, secret-free and safe to run.
A pipeline must also make it hard to publish or deploy by accident.

### What you will learn

- Why `npm ci --omit=dev` can fail to remove development tools in a monorepo, and how tracing fixes it.
- How to combine Next.js standalone output with a custom server.
- How native binaries (the Claude Code CLI, the Prisma schema engine) depend on CPU and C library.
- How to separate read-only code from writable data, and verify it.
- Why deleting a file in a Dockerfile does not remove it from the image.
- How to test a security scanner itself.
- How OIDC and environment approvals make releases safe.

## 2. Steps performed

The steps below are in the order they were actually done, including the mistakes found and fixed
along the way.

### Step 1 — Inspect the project and restore dependencies

The agent read `AGENTS.md` and `docs/project-state.md`, then restored the missing `node_modules`:

```bash
npm ci --ignore-scripts --prefer-offline --cache .npm-cache
npm run build
```

Key findings:

- The SDK package `@anthropic-ai/claude-agent-sdk` 0.3.276 contains **no** CLI itself. Claude Code
  2.1.276 lives in optional per-platform packages, and the lockfile records each package's CPU and C
  library (`glibc` or `musl`).
- The **API** also needs the CLI, not just the worker: in Claude mode it analyzes articles on demand.
- Next.js tracing included the SDK's JavaScript but **not** its native CLI, because the SDK loads it
  dynamically.

### Step 2 — Add a `.dockerignore` allowlist

[`.dockerignore`](.dockerignore) starts with `*` (ignore everything), then allows only the
`package.json`/lockfile pair, `apps/`, `packages/` and `docker/`. It still blocks:

- `.env*` files;
- `.claude`, `.codex` and `.agents` folders, plus `CLAUDE.md` and `AGENTS.md`;
- `.local` (where session artifacts live) and transcripts;
- host build output;
- tests, including the test-only `apps/api/lib/testing`.

### Step 3 — Worker image, and why tracing replaced `npm ci --omit=dev`

The first worker image used `npm ci --omit=dev --workspace=@portfolio-pilot/worker`. Inspecting it
showed TypeScript, Vite, Vitest and the Prisma CLI inside. An experiment compared the options:

```text
omit-dev-all:         typescript vite vitest prisma next react ...   1.1G
omit-dev-ws (worker): typescript vite vitest prisma react ...        679M
```

The lockfile marks those tools `devOptional` (optional peers of runtime packages), so npm keeps them.
Omitting *optional* packages too would also delete the Claude CLI. The fix was a new build helper,
[`docker/trace-runtime.mjs`](docker/trace-runtime.mjs), which uses `@vercel/nft` to copy only the
files the entry points can load. One new dev dependency was added:

```bash
npm install --save-dev --save-exact @vercel/nft@1.11.0 --ignore-scripts
```

The lockfile gained 33 packages, and the agent compared it package by package to confirm that no
existing version changed. The traced worker tree shrank from 679 MB of `node_modules` to 245 MB,
of which 221 MB is the Claude CLI.

### Step 4 — An SDK runtime gate

[`docker/check-sdk-runtime.mjs`](docker/check-sdk-runtime.mjs) runs at the end of every API and
worker build, **as the runtime user**. It finds the native CLI exactly as the SDK does, checks that
its version matches the SDK pin, and executes `claude --version`. If the binary is missing, or is
built for the wrong CPU or C library, the build fails.

### Step 5 — API image: Next.js standalone output plus the custom server

[`apps/api/next.config.mjs`](apps/api/next.config.mjs) now sets `output: 'standalone'`, traces from
the monorepo root, and adds the SDK's Linux CLI package to the trace.

Next.js documents that standalone output does not trace custom servers. This project needs its custom
[`apps/api/server.mjs`](apps/api/server.mjs) because it implements the graceful shutdown from
milestone 30. So the API Dockerfile:

1. traces `server.mjs` and merges only its extra dependencies (`zod` and the config package) into
   the standalone folder;
2. removes the generated `server.js` and the unused `sharp` image library.

`server.mjs` now loads the configuration that `next build` saved (`.next/required-server-files.json`),
exactly as Next's own standalone server does.

Problems found and fixed in this step:

- **Test code in the build.** The Next.js type check reached test-only files; they are now excluded
  from the build context.
- **Oversized trace.** Tracing `server.mjs` first pulled in 27 MB of Next.js development files, so
  `next/` is now left to Next's own trace.

### Step 6 — Migration image

[`docker/migrate.Dockerfile`](docker/migrate.Dockerfile) traces the Prisma CLI and includes the
migrations plus the database schema engine, which is downloaded **at build time**. Tested against a
fresh PostgreSQL container, it printed `All migrations have been successfully applied.` (20
migrations). Without `DATABASE_URL` it stops with exit code 2 instead of falling back to a
development address.

### Step 7 — Web image and nginx

[`docker/web.Dockerfile`](docker/web.Dockerfile) builds the React app and serves it with unprivileged
nginx 1.30.5 (uid 101). [`docker/nginx/default.conf.template`](docker/nginx/default.conf.template)
provides:

- **SPA fallback:** application routes return `index.html`.
- **Asset handling:** hashed `/assets/` are cached "forever", but a missing file returns `404`, never HTML.
- **An `/api/` proxy for SSE:** buffering off and long timeouts.
- **Security headers,** including a strict Content Security Policy
  ([`docker/nginx/security-headers.conf`](docker/nginx/security-headers.conf)).
- **JSON errors:** when the API is unreachable, nginx returns the app's JSON error format.

Two bugs were found by testing and fixed:

- a missing asset's `404` was marked cacheable "forever";
- nginx's own `502` was an HTML page.

### Step 8 — Production-like Compose stack

[`compose.production.yaml`](compose.production.yaml) starts PostgreSQL and Redis, then:

```text
migrate (one-shot) -> seed-demo (one-shot) -> api + worker-ingestion + worker-outbox + worker-agent -> web
```

Every app container is read-only, drops all Linux capabilities and cannot gain new privileges. Only
`http://localhost:8080` is exposed.

Key decisions:

- **Production by default.** The images start with `NODE_ENV=production`, which refuses demo sign-in.
  The Compose file opts into the local demo profile on purpose.
- **The seed's safety check was kept.** The demo seed only accepts a loopback (`127.0.0.1`) database
  address. Instead of weakening that check, the seed container joins PostgreSQL's network namespace,
  so it really connects over `127.0.0.1`.

### Step 9 — Containerized smoke test

[`scripts/verify-containers.mjs`](scripts/verify-containers.mjs) (`npm run verify:containers`) builds
and starts the stack, runs eight checks (listed in [section 3](#3-results-achieved)), and then
removes it.

Two of the agent's own assertions were wrong and were corrected:

- **The trade status code.** The trade endpoint returns `200`, not `201`.
- **The SSE check.** A timing-based check measured the app's normal batching instead of proxy
  buffering. It now checks that every event arrived while the stream was still open.

### Step 10 — Real SDK turn inside the images

[`docker/verify/sdk-fixture-probe.mjs`](docker/verify/sdk-fixture-probe.mjs) runs the bundled Claude
Code CLI in the API and worker images against a **local fake model server**. It needs no API key or
network, and runs as uid 10001 on a read-only filesystem. The CLI wrote only to the agent workspace
folder. This probe is mounted only for the test and is not baked into any image.

### Step 11 — Image and secret inspection

[`scripts/inspect-images.mjs`](scripts/inspect-images.mjs) (`npm run inspect:images`) saves each image
and reads **every layer**. It also checks the image configuration, the build history and the browser
files.

- **First run:** it reported false positives. Next.js and npm contain the *text*
  `BEGIN PRIVATE KEY` because they detect keys, and binary data contained random `AKIA…` strings. The
  agent made the rules precise.
- **A real finding:** npm's files were still present in the Node base image layers, even though the
  Dockerfile deleted them. The runtime images were therefore rebuilt on `debian:trixie-slim` plus only
  the `node` binary, `tini` (a tiny init process that forwards shutdown signals) and `ca-certificates`.
- **Proving the scanner works:** `--self-test` builds a "canary" image with seven planted problems and
  requires the scanner to find all of them.

### Step 12 — GitHub Actions

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs install, build, typecheck, lint, unit
  tests, the mock evaluation, integration tests, browser tests, the amd64 images (scan plus smoke
  test) and native arm64 builds.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) publishes and deploys, with several
  safety locks:
  - it starts only manually, only from `main`, and only if the repository variable
    `RELEASE_ENABLED` is `true`;
  - its jobs wait for reviewers through the GitHub environments `release-registry` and `production`;
  - it signs in to Azure with OIDC only, with no stored secrets;
  - its deploy job deliberately stops before rolling out anything (that is milestone 35).

Every action is pinned to a full commit SHA, and both files passed `actionlint` 1.7.12.

### Step 13 — Regression tests and documentation

The full existing test suites were rerun (results below). These documents were created or updated:

- [ADR 0025](docs/decisions/0025-production-containers-and-release-pipeline.md) and
  [lesson 33](docs/lessons/33-production-containers-and-release-ci.md) (created);
- [`docs/versions.md`](docs/versions.md), [`docs/project-state.md`](docs/project-state.md) and
  [`docs/verification-report.md`](docs/verification-report.md) (updated).

### Files at a glance

| Created | Modified |
| --- | --- |
| `.dockerignore`, `compose.production.yaml` | `apps/api/next.config.mjs` |
| `docker/{web,api,worker,migrate}.Dockerfile` | `apps/api/server.mjs` |
| `docker/trace-runtime.mjs`, `docker/check-sdk-runtime.mjs` | `package.json`, `package-lock.json` |
| `docker/nginx/default.conf.template`, `docker/nginx/security-headers.conf` | `.gitignore` |
| `docker/verify/sdk-fixture-probe.mjs` | `docs/versions.md`, `docs/project-state.md` |
| `scripts/verify-containers.mjs`, `scripts/inspect-images.mjs` | `docs/verification-report.md`, `docs/decisions/README.md` |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml` | |
| ADR 0025, lesson 33, this README | |

## 3. Results achieved

### The four images

These were observed on 2026-10-03 on linux/amd64. Sizes are the compressed sizes reported by Docker.

| Image | What it runs | User | Size |
| --- | --- | --- | --- |
| `portfolio-pilot-web` | nginx: React app, SPA fallback, `/api` proxy | 101 | 22 MB |
| `portfolio-pilot-api` | Next.js API via `server.mjs` | 10001 | 184 MB |
| `portfolio-pilot-worker` | ingestion, outbox or agent role (`WORKER_ROLE`) | 10001 | 180 MB |
| `portfolio-pilot-migrate` | `prisma migrate deploy` | 10001 | 106 MB |

The Claude CLI accounts for most of the API and worker size: 221 MiB uncompressed, about 97 MiB
compressed.

### How the running system behaves

- Open `http://localhost:8080`. nginx serves the React app, and every `/api/...` request goes to the
  API container.
- A trade or a question travels API → PostgreSQL → worker → Redis → API → browser over SSE, all
  through nginx.
- Only three paths are writable inside a container: `/tmp`, the SDK workspace
  `/var/lib/portfolio-pilot/agent-workspace`, and `/var/lib/portfolio-pilot/session-artifacts`.
  Writing to the application code fails.
- On `docker compose stop`, every role finishes its work and exits with code `0`.

### SDK build gate output (observed)

```text
{"sdk":"0.3.276","claudeCode":"2.1.276","native":"@anthropic-ai/claude-agent-sdk-linux-x64",
 "binary":"/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
 "version":"2.1.276 (Claude Code)","arch":"x64","libc":"glibc"}
```

### Smoke test output (observed)

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

### Secret inspection output (observed)

```text
SELF-TEST PASS: all 7 planted violations detected, including a file deleted in a later layer.
PASS: 4 images, no secrets, .env files, transcripts, session artifacts or agent settings; 1 local secret value(s) checked.
```

### All check results (observed 2026-10-03, Windows 11, Docker Desktop)

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run check:browser-boundary` | passed |
| `npm run test:unit` | 357 passed, 0 failed, 4 skipped (live tests, skipped by design) |
| `npm run test:integration` | 127 passed, 0 failed |
| `npm run test:browser` | 30 passed, 0 failed |
| `npm run eval:mock` | gates passed 7/7, mean quality 0.907 |
| `npm run verify:containers` | 8/8 PASS |
| `npm run inspect:images` (and `--self-test`) | PASS (self-test 7/7) |
| `actionlint` 1.7.12 on both workflows | no findings |

## 4. How to run and verify

### Prerequisites

- **Node.js 24.21.0 and npm 11.19.0** (see `.nvmrc`).
- **Docker** with Docker Compose v2 and Buildx (Docker Desktop on Windows or macOS). Docker must be
  running.
- **Port 8080** must be free.
- **Optional:** Google Chrome, needed only for `npm run test:browser`.
- **No credentials:** everything below uses mocks, so no Anthropic key, Azure account or market-data
  key is needed.

Install dependencies from the lockfile:

```bash
npm ci --ignore-scripts
```

### A. One command: build, start, check and clean up

```bash
npm run verify:containers
```

You should see the eight `PASS` lines shown above, followed by a JSON summary. The command removes its
containers and volumes when it finishes. Useful options:

```bash
npm run verify:containers -- --keep         # leave the stack running for inspection
npm run verify:containers -- --skip-build   # reuse already built images
```

### B. Inspect the images for secrets

Run this after the images are built (step A builds them with the tag `local`):

```bash
npm run inspect:images -- --self-test   # proves the scanner catches planted problems
npm run inspect:images                  # scans the four real images
```

### C. Try the app yourself

The stack needs a shared secret of at least 32 characters. Generate one:

```bash
# Bash (Git Bash, macOS, Linux)
export PORTFOLIO_PILOT_AUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
```

```powershell
# PowerShell
$env:PORTFOLIO_PILOT_AUTH_SECRET = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Start the stack, wait until it is healthy, then open http://localhost:8080 and use demo sign-in
(`alice` or `bob`):

```bash
docker compose -f compose.production.yaml up -d --build --wait
docker compose -f compose.production.yaml ps
```

Things to check yourself:

```bash
curl http://localhost:8080/api/health/ready        # {"status":"ready",...}
curl -I http://localhost:8080/portfolios/anything  # 200, text/html (SPA fallback)
curl -I http://localhost:8080/assets/missing.js    # 404, not HTML
docker compose -f compose.production.yaml exec api sh -c "touch /app/x"   # fails: read-only
```

Stop and remove everything, including the demo database:

```bash
docker compose -f compose.production.yaml down -v
```

> Without `PORTFOLIO_PILOT_AUTH_SECRET`, the API and workers refuse to start. This is intentional:
> they "fail closed".

### D. Run the real Claude Code CLI inside an image (no key, no network)

In Git Bash, prefix the command with `MSYS_NO_PATHCONV=1` so the container paths are not rewritten:

```bash
docker run --rm --read-only --network none --tmpfs /tmp \
  --tmpfs /var/lib/portfolio-pilot/agent-workspace:uid=10001,gid=10001,mode=0700 \
  -v "$PWD/docker/verify:/verify:ro" --entrypoint node \
  portfolio-pilot-worker:local /verify/sdk-fixture-probe.mjs /app/packages/agent
```

The expected output is one JSON line containing `"ok":true`, `"uid":10001` and a `.jsonl` transcript
inside the workspace.

### E. Build a single image

```bash
docker build -f docker/worker.Dockerfile -t portfolio-pilot-worker:local .
```

The same pattern works for `web`, `api` and `migrate`.

### F. The regular test suites

```bash
npm run typecheck
npm run test:unit
npm run test:integration   # needs Docker
npm run test:browser       # needs Docker and Google Chrome
npm run eval:mock
```

## 5. Limitations and unfinished work

- **Nothing was published or deployed.** No image was pushed to any registry, and no Azure resources
  exist. This was intentional, as the prompt required.
- **The GitHub workflows have never run.** This folder is not a Git repository and has no GitHub
  remote. They were only checked with `actionlint`.
- **arm64 is not verified on this machine.** Docker Desktop here has no arm64 emulation (the build
  failed with `exec format error`). Enabling it needs a privileged container that changes Docker's
  virtual machine, which was not done without permission. `ci.yml` is set up to build arm64 natively
  on GitHub's `ubuntu-24.04-arm` runners. The command to try locally, if allowed:

  ```bash
  docker run --privileged --rm tonistiigi/binfmt --install arm64
  docker buildx build --platform linux/arm64 -f docker/worker.Dockerfile .
  ```

- **The release pipeline is configured but not set up.** It needs, in GitHub and Azure:
  - the `release-registry` and `production` environments with required reviewers;
  - Azure workload identities with federated credentials (milestone 34);
  - the variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `ACR_NAME`;
  - finally `RELEASE_ENABLED=true`.
- **The deploy step stops on purpose.** The Kubernetes migration Job and rollout arrive in milestone
  35.
- **Live Claude is not tested in containers.** The CLI was tested only against a local fake model
  server. A live test needs `ANTHROPIC_API_KEY`, a model ID and spending approval.
- **Supported platforms:**
  - **linux/amd64 (glibc):** verified.
  - **linux/arm64 (glibc):** expected to work, gated in CI, not verified here.
  - **Not supported:** Alpine/musl Node images and Windows containers.
- **Next.js internals.** `server.mjs` relies on an internal Next.js setting
  (`__NEXT_PRIVATE_STANDALONE_CONFIG`). After any Next.js upgrade, rerun `npm run verify:containers`.
- **Known advisories in the migrate image.** It includes the Prisma CLI, which carries four known
  `npm audit` advisories (`deepmerge-ts`, `mysql2`). The API and worker images do not contain them.
- **Compose is not the production topology.**
  - It runs only one API replica; multi-replica routing belongs to the Kubernetes gateway
    (milestone 35).
  - Container health checks cover liveness only; readiness probes come in milestone 35.

## Where to read more

- [Lesson 33](docs/lessons/33-production-containers-and-release-ci.md): teaching notes, common
  mistakes.
- [ADR 0025](docs/decisions/0025-production-containers-and-release-pipeline.md): decisions and rejected
  alternatives.
- [Project state](docs/project-state.md): the current milestone report and next steps.
- [Verification report](docs/verification-report.md): how to verify the whole system.
- [Versions](docs/versions.md): pinned image digests and action SHAs.
- [AGENTS.md](AGENTS.md): the project rules every coding assistant follows.
