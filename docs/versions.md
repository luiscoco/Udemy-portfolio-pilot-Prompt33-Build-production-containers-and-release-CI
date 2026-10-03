# PortfolioPilot toolchain (milestone 01)

Verified on **2026-09-30**. These are exact intended direct dependency versions for milestone 02 and later. Keep matching package versions exact in workspace manifests; generate and commit `package-lock.json` when dependencies can be installed and a commit is authorized. No packages were installed in milestone 01.

| Tool or package | Selected version | Use |
| --- | --- | --- |
| Node.js | **24.21.0 LTS** | All JavaScript development and server runtimes |
| npm | **11.19.0** | Bundled with Node.js 24.21.0; npm workspaces |
| `react` | **19.3.0** | Vite web application |
| `react-dom` | **19.3.0** | Same React release as `react` |
| `vite` | **8.3.1** | Web development/build |
| `typescript` | **5.9.3** | Shared compiler version |
| `next` | **16.3.8** | Node.js API Route Handlers only |
| `prisma` | **7.10.0** | CLI and migrations |
| `@prisma/client` | **7.10.0** | Generated client; match Prisma CLI |
| `@anthropic-ai/claude-agent-sdk` | **0.3.276** | Server-only agent runtime |
| `zod` | **4.6.4** | Shared and server validation |
| `vitest` | **5.0.0** | Unit/integration tests |
| `@playwright/test` | **1.63.0** | Browser end-to-end tests |

## Compatibility basis

- [Node.js release status](https://nodejs.org/en/about/previous-releases) lists 24 as LTS. The [24.21.0 archive](https://nodejs.org/en/download/archive/v24.21.0) records npm 11.19.0. Pinning one LTS patch makes lessons repeatable. Node 26 was still Current on the verification date.
- [React's release list](https://react.dev/versions) and [19.3 announcement](https://react.dev/blog/2026/09/09/react-19-3) confirm 19.3.0 is stable. The [npm React DOM listing](https://www.npmjs.com/package/react-dom?activeTab=versions) lists 19.3.0 as stable; keep `react` and `react-dom` identical. No canary or release candidate is selected.
- The [Next.js 16.3.8 registry manifest](https://registry.npmjs.org/next/16.3.8) declares Node `>=20.9.0` and peer dependencies `react` and `react-dom` `^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0`. React 19.3.0 satisfies the stable `^19.0.0` range. The [Next.js installation docs](https://nextjs.org/docs/app/getting-started/installation) also document Node 20.9+ and TypeScript 5.1+.
- The [Vite 8.3 npm listing](https://www.npmjs.com/package/vite?activeTab=versions) identifies 8.3.1 as stable. The [Vite 8 announcement](https://v8.vite.dev/blog/announcing-vite8) requires Node 20.19+ or 22.12+; Node 24.21.0 is a supported newer LTS line.
- The [Prisma 7 package listings](https://www.npmjs.com/package/%40prisma/client?activeTab=versions) identify 7.10.0 for `@prisma/client`, and the [Prisma release-status page](https://www.prisma.io/docs/orm/release-status) says Prisma 8 is a release candidate as of this verification. Select `prisma` and `@prisma/client` together at stable 7.10.0. [Prisma 7 requirements](https://www.prisma.io/docs/orm/v7/reference/system-requirements) allow Node `^24.0.0` and TypeScript 5.4+; its [v7 upgrade guide](https://docs.prisma.io/docs/orm/v6/more/upgrades/to-v7) recommends TypeScript 5.9.x and ESM. This is why TypeScript 5.9.3 is selected instead of the newer 7.x line.
- Anthropic's [SDK 0.3.276 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.276) confirms the version, and its [changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) records Zod 4 as an accepted peer range. The [Zod npm listing](https://www.npmjs.com/package/zod?activeTab=versions) confirms 4.6.4 as a stable 4.x version. The SDK's installed type definitions and full package peer/engine metadata remain to be checked at installation; do not assume an SDK method or model ID from this document.
- [Vitest 5 migration guidance](https://main.vitest.dev/guide/migration/) requires Vite 6.4+ and Node 22.12+; Vite 8.3.1 and Node 24.21.0 clear those floors. The [Vitest npm listing](https://www.npmjs.com/package/vitest?activeTab=readme) confirms 5.0.0. The [Playwright npm listing](https://www.npmjs.com/package/%40playwright/test) and [official release notes](https://playwright.dev/docs/release-notes) confirm 1.63.0. Playwright browser binaries are a separate local installation.

At milestone 01, registry package pages and the Next.js registry manifest were checked through web access. Direct npm registry access from that PowerShell session failed, so the compatibility claims above were not then a report of a successful local install. The milestone 02 update below records the later installation.

## Milestone 02 resolution update (2026-09-30)

The approved direct runtime versions above were installed without substitutions; `package-lock.json` now records the resolved graph. The scaffold additionally needs exact TypeScript declaration packages: `@types/node` 24.10.0, `@types/react` 19.2.7, and `@types/react-dom` 19.2.3. These versions resolved and compiled with the approved Node/React/TypeScript set. `@playwright/test` remains a planned version; milestone 02 has no browser automation suite or browser binary install. `npm install` succeeded with 295 packages. npm reported that Prisma 7.10.0 install scripts were not allowlisted; Prisma generation is deferred to milestone 06, when its schema exists.

The normal npm shim is blocked by the local NVM trust check, but invoking the installed npm CLI with the installed Node executable works. Registry access required sandbox escalation. The root scripts were verified through that direct invocation. The installed Next.js type definitions and bundled agent guide were inspected for `agentRules`; the option is set to false to avoid generation of nested assistant instruction files.

## Milestone 03 additions (2026-09-30)

The web workspace adds `react-router` 8.3.0 for declarative client routes and `@tanstack/react-query` 5.102.8 for server state. It also installs the previously planned `@playwright/test` 1.63.0 for local browser verification. All are pinned exactly in the manifest and lockfile. React Router's official declarative-mode documentation confirms `BrowserRouter`, `Routes`, `Route`, and `NavLink` usage; TanStack Query's installation documentation confirms React 18+ compatibility and the `QueryClientProvider` pattern. Styling uses project CSS, so no component library was needed. No previous direct dependency was upgraded for this milestone.

## Milestone 05 additions (2026-10-01)

The development Compose file pins `postgres:17.6-alpine` and `redis:7.4.5-alpine`, both official images. The database workspace adds `@prisma/adapter-pg` 7.10.0 to match Prisma, `pg` 8.16.3, `@types/pg` 8.15.5, and `redis` 5.10.0. These exact versions are in the manifest and lockfile. [Prisma 7's setup guide](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/introduction) requires a driver adapter; [Redis's Node guide](https://redis.io/docs/latest/develop/clients/nodejs/connect/) documents `createClient`, bounded reconnection strategy, and connection events. Generation and TypeScript compilation passed. No prior direct dependency was upgraded.

## Local prerequisites observed

| Check | Result |
| --- | --- |
| `node --version`, `npm --version` | Both report **no active Node.js version configured** in this session. `nvm list` reports 24.21.0 installed, but `nvm` also reports registry access denied while reading/updating its environment. |
| `git --version` | 2.52.0.windows.1. `git status --short` reports this workspace is **not a Git repository**; the prior milestone state said it was, so verify the intended checkout before committing. |
| `docker --version` | Docker CLI 28.5.2. |
| `docker compose version` | Compose v2.40.3-desktop.1. |
| `docker info --format '{{.ServerVersion}}'` | Failed: access denied to Docker's config/engine pipe. Daemon availability is unverified; Docker is not needed for this documentation milestone. |
| Workspace | Documentation files only before this milestone; no app packages, `node_modules`, lockfile, database volume, or test runner. |
| Credentials | No `ANTHROPIC_API_KEY` or `DATABASE_URL` environment-variable names were listed. Values were not read. Credentials are not needed for this milestone. |

## Reproduce and verify

Run these from the repository root. Native Windows uses the installed `nvm` executable; in Linux/WSL2 use your own Node version manager or the official Node 24.21.0 distribution. No global tool installation is part of this milestone.

**Windows PowerShell**

```powershell
nvm use 24.21.0
node --version
npm --version
git --version
docker --version
docker compose version
docker info --format '{{.ServerVersion}}'

# After the monorepo manifests are created in milestone 02:
npm install --package-lock-only --ignore-scripts
npm install
npm ls react react-dom vite typescript next prisma @prisma/client @anthropic-ai/claude-agent-sdk zod vitest @playwright/test
```

**Linux / WSL2 (with `nvm-sh` already installed)**

```bash
nvm install 24.21.0
nvm use 24.21.0
node --version
npm --version
git --version
docker --version
docker compose version
docker info --format '{{.ServerVersion}}'

# After the monorepo manifests are created in milestone 02:
npm install --package-lock-only --ignore-scripts
npm install
npm ls react react-dom vite typescript next prisma @prisma/client @anthropic-ai/claude-agent-sdk zod vitest @playwright/test
```

If `nvm use` fails on this Windows host, open a shell with permission to activate the already installed version or use the [official Node.js 24.21.0 installer](https://nodejs.org/en/download/archive/v24.21.0). Check `node --version` before running npm. A resolved lockfile and any transitive peer checks await a working Node/npm session and milestone 02 manifests. Do not use `--legacy-peer-deps` to hide a conflict; resolve and document it.

## Milestone 06 verification — 2026-10-01

No direct dependencies were added or upgraded. Prisma/client/adapter remain 7.10.0.
Official [Prisma 7 migration/configuration docs](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)
and installed CLI/types were checked for config, generation and migration commands.
The [Better Auth core schema](https://better-auth.com/docs/concepts/database) was checked for
User/Session/Account/Verification fields. Its runtime package/version is intentionally deferred to
milestone 07, which must validate the schema against the chosen maintained release.
PostgreSQL 17.6 successfully executed the initial SQL and numeric/check/relationship tests.

## Milestone 07 authentication — 2026-10-01

Added and pinned `better-auth` **1.7.7** in apps/api; resolved transitive dependencies are in package-lock.json. No existing direct dependency versions changed. Official Microsoft provider, Prisma adapter, Next.js integration, plugin endpoint, security and session documentation and installed types/source were checked; see ADR 0003. The milestone 06 auth schema works with this release, verified by real database login/logout tests. Explicit security flags override the library's test-mode defaults. Production startup exits on invalid config because Next.js can retain a process after instrumentation throws. Build warnings include existing Vite directive/Next instrumentation analysis warnings and analysis of the additional production exit.

## Milestone 08 APIs — 2026-10-01

No external dependency versions changed. The DB workspace now declares existing contracts/domain workspace dependencies; lockfile metadata refreshed. Prisma 7.10.0 installed transaction types and adapter error mapping and Next.js 16.3.8 bundled route documentation were checked. Current online Prisma docs have moved to ORM 8; use the installed pinned ORM 7 API. BigInt fixed-point arithmetic avoids introducing a decimal library or binary floating-point money calculations. See ADR 0004.

## Milestone 13 note (2026-10-02)

No dependency was added or upgraded. The outbox/stream code uses the already pinned `redis` 5.10.0
client and the Compose `redis:7.4.5-alpine` server. It requires Redis ≥ 7.0 for `XINFO STREAM`
`max-deleted-entry-id`/`recorded-first-entry-id`/`entries-added` and ≥ 6.2 for exclusive `XRANGE`.
Azure Managed Redis must be provisioned with a compatible engine version (checked in milestone 34).
PostgreSQL ≥ 13 is required for built-in `gen_random_uuid()` (Compose pins 17.6). `zod` stays only in
`contracts`; request schemas for new routes were added there rather than adding `zod` to `db`.


## Milestone 17 agent tools — 2026-10-02

No resolved package version changed and nothing was downloaded (`npm install --offline` against the
existing cache). `packages/agent` now declares `zod` **4.6.5** and, as a dev dependency,
`@modelcontextprotocol/sdk` **1.31.0**. Both were already installed at the root as peers of
`@anthropic-ai/claude-agent-sdk` 0.3.276. The compatibility reason: SDK `tool()` input shapes must
come from the same Zod instance the in-process MCP server uses to validate arguments and generate
JSON Schema. `contracts` keeps its own pinned 4.6.4 for browser DTOs; agent tool schemas never mix
the two instances. The MCP SDK dev dependency is used only by tests (protocol-level `Client` and
`InMemoryTransport`) to verify registration. The lockfile change is metadata only: workspace
dependency entries and removed `peer` flags. APIs were verified in the installed `sdk.d.ts`
(`tool`, `createSdkMcpServer`, `Options.tools/allowedTools/disallowedTools/mcpServers/strictMcpConfig/
canUseTool/settingSources/skills/agents/plugins`) and the official
[custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools) and
[tool search](https://code.claude.com/docs/en/agent-sdk/tool-search) pages. See ADR 0010.

## Milestone 22 - 2026-10-02

No resolved dependency versions changed. The worker now declares the existing local agent and contracts workspaces to process owner-scoped news research before outbox acknowledgement. The lockfile records those workspace dependency additions. Prisma 7.10.0 generated AlertRule/AlertNotification types and Next.js 16.3.8 installed route-handler documentation were checked; official references are in ADR 0015. Offline installation restored workspace links copied as ordinary directories in this snapshot.

## Milestone 23 - 2026-10-02

No resolved versions changed. MCP SDK 1.31.0 moved from the agent's dev dependencies to runtime
dependencies because the bounded research wrapper and fixture server import it. Lockfile metadata
updated offline. Agent SDK 0.3.276 types and bundled CLI manifest 2.1.276 were checked against the
official subagent, MCP, hooks, streaming and cost docs (ADR 0016). Current official MCP docs also
describe v2; this milestone deliberately uses the already installed v1 APIs and transport buffer
implementation. Actual stdio process tests verify behavior. Native Claude delegation and reported
nested usage remain unverified without credentials; the opt-in comparison command is in lesson 23.

## Milestone 24 - 2026-10-02

No dependency versions or lockfile changed. SDK 0.3.276 / bundled CLI 2.1.276 types verify
settingSources, settings, skills, cwd, hooks, HookInput/HookCallback and startup control methods.
Official skills, hooks and settings pages were read (ADR 0017). An actual credential-free SDK
startup confirms application skills and hook registration with personal/ancestor configuration
excluded. Native briefing adherence is covered by an opt-in live test, unexecuted without credentials.


## Milestone 25 - 2026-10-02

No dependency versions or lockfile changed. SDK 0.3.276 / CLI 2.1.276 installed definitions
verify CanUseTool, PermissionResult, abort signal, updatedInput, interrupt, and PreToolUse
permissionDecision ask. Official permission/user-input docs checked; see ADR 0018.
Writes are excluded from preapproval, default mode reaches canUseTool, and handler checks remain
mandatory. Prisma 7.10.0 generated the new client; all fourteen migrations applied to a fresh
local PostgreSQL database. Next 16.3.8's installed Route Handler guide was read before editing.

## Milestone 26 - 2026-10-03

No dependency or lockfile version changes. SDK 0.3.276 / CLI 2.1.276 installed types verify
maxTurns/maxBudgetUsd, init.model, assistant.message.model/usage, result total_cost_usd,
modelUsage, num_turns and error-result telemetry. Installed result comments specify per-query
totals on resume. Current official cost docs explicitly date restored session totals to CLI
2.1.277; the app therefore guards runtime version on resume, rather than applying newer semantics
to the pinned runtime. Costs are SDK estimates, never billed cost. See ADR 0019.
Prisma 7.10.0 client generation and all fifteen migrations passed against a fresh local DB.
Next's installed Route Handler guide was read before the API response-code change.

## Milestone 28 - 2026-10-03

No dependency or lockfile version changes. Official session-storage, sessions and hosting docs were
read alongside installed SDK 0.3.276 definitions/source. Verified `SessionStore`, `SessionKey`,
`SessionStoreEntry`, `Options.sessionStore`, eager flush, `listSubkeys`, `mirror_error` and
`importSessionToStore`; there is no archive export/import API in this version. These session-store
APIs are marked alpha by the installed types, so envelope metadata pins SDK 0.3.276 and upgrades
require rerunning the actual-CLI HTTP-fixture restart test. Azure uses the documented Blob REST
2023-11-03 contract and Entra federated client-credentials flow; no new Azure library was installed.
Prisma 7.10.0 generated the client and all eighteen migrations applied to an isolated local database.
See ADR 0021 for the exact artifact inventory and retention/security requirements.

## Milestone 29 compatibility verification (2026-10-03)

No third-party versions changed. The agent now depends on the existing internal observability
workspace for metadata log redaction; `package-lock.json` records that workspace edge. Installed
SDK 0.3.276 permission/option types and Next.js 16.3.8 bundled Route Handler documentation were
checked alongside official SDK permissions and secure-deployment guidance (ADR 0022). Runtime
policy key `skills-policy-v2-hardened` intentionally reseeds older incompatible checkpoints.

## Milestone 32 additions (2026-10-03)

New exact dependencies of `@portfolio-pilot/observability` (registry versions checked with
`npm view` on 2026-10-03; all are the current `latest` tags, and the 2.x SDK packages declare peer
`@opentelemetry/api >=1.0.0 <1.10.0` and Node `^18.19.0 || >=20.6.0`):

| Package | Version | Use |
| --- | --- | --- |
| `@opentelemetry/api` | 1.9.1 | Tracing/metrics API (global registration shared with Next.js's bundled copy) |
| `@opentelemetry/sdk-trace-node` / `sdk-trace-base` | 2.11.0 | Tracer provider with AsyncLocalStorage context; span processors |
| `@opentelemetry/sdk-metrics` | 2.11.0 | Meter provider and readers |
| `@opentelemetry/resources` / `core` | 2.11.0 | Resource attributes; W3C trace-context propagator, time helpers |
| `@opentelemetry/semantic-conventions` | 1.43.0 | `service.name` / `service.version` keys |
| `@opentelemetry/exporter-trace-otlp-http` / `exporter-metrics-otlp-http` | 0.222.0 | OTLP/HTTP to Jaeger or a collector |
| `@opentelemetry/exporter-prometheus` | 0.222.0 | Local scrape endpoint |

Installed type definitions were read before use. In 2.x `sdk-trace-base` re-exports
`@opentelemetry/sdk-trace`, providers take `spanProcessors` in the constructor, and `ReadableSpan` exposes
`parentSpanContext` (not `parentSpanId`). `@azure/monitor-opentelemetry-exporter` was **not**
adopted: its `latest` dist-tag is `1.0.0-beta.32` (beta tag `1.0.0-beta.45`). Azure Monitor is reached
through the collector instead (ADR 0024).

Container images (not npm): `jaegertracing/jaeger:2.21.0` (optional Compose profile, Docker Hub tag
dated 2026-09-15; the v2 query API is under `/api/v3`) and `otel/opentelemetry-collector-contrib:0.161.0`
(collector configs validated with `validate`; Microsoft requires ≥ 0.148.0 for `azure_auth`).

`npm ci` reports 4 high-severity advisories, all in the existing Prisma 7.10.0 CLI tree
(`deepmerge-ts` via `@prisma/config`, and `mysql2`). The suggested fix downgrades to Prisma 6, a breaking
change, so it is not applied. The new OpenTelemetry packages add no advisories. One new migration,
`20261017100000_trace_context`, was applied by the test harness to fresh disposable databases.

## Milestone 33 additions (2026-10-03)

**npm.** `@vercel/nft` **1.11.0** (npm `latest`, Node `>=20`) is a root devDependency, used only at
image build time (`docker/trace-runtime.mjs`). It is the tracer behind Next.js output tracing and
replaces `npm ci --omit=dev`, which kept `devOptional` build tools (ADR 0025). The lockfile gained 33
packages; no existing locked version changed (compared package by package). `npm audit` still reports
the 4 high advisories in the Prisma 7.10.0 CLI tree; the CLI now also ships in the migrate image (not
in the API or worker images). See ADR 0025, Consequences.

**Container base images** (tag and multi-arch index digest, both amd64 and arm64, checked with
`docker buildx imagetools inspect`):

| Image | Pin | Use |
| --- | --- | --- |
| `node:24.21.0-trixie-slim` | `sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe` | Build stages; source of the runtime `node` binary (matches `.nvmrc`/`engines`) |
| `debian:trixie-slim` | `sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a` | API/worker/migrate runtime (+ `tini`, `ca-certificates` from Debian 13) |
| `nginxinc/nginx-unprivileged:1.30.5-alpine` | `sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e` | Web runtime; latest 1.30.x stable tag found (1.30.6 does not exist; 1.31 is mainline) |

**Runtime binaries inside the images** (not installed separately):

- Claude Code **2.1.276**, from `@anthropic-ai/claude-agent-sdk-linux-<arch>` 0.3.276 (the SDK's
  `claudeCodeVersion`).
- Prisma schema engine for commit `0edf323e...` (`schema-engine-debian-openssl-3.0.x` on amd64),
  downloaded by `prisma generate` during the migrate image build.

**CI.** Actions are pinned to full commit SHAs, resolved with `git ls-remote`. Inputs were read from
each `action.yml` at that SHA:

| Action | Tag | Commit |
| --- | --- | --- |
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| actions/upload-artifact | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| actions/download-artifact | v8.0.1 | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |
| docker/setup-buildx-action | v4.4.1 | `f87e5991a6d7451dcb8d9637bfbc97413f497069` |
| docker/build-push-action | v7.4.0 | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` |
| azure/login | v3.1.0 | `a641126d1b8aa4d1fa005f4f92df94a3a4c4c906` (annotated tag, dereferenced) |
| actions/attest-build-provenance | v4.2.2 | `4d101475d8b20a2381f78447822ac1eab6504dd8` |

Workflows were linted with `rhysd/actionlint` 1.7.12 (Docker image
`sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667`) with no findings.
