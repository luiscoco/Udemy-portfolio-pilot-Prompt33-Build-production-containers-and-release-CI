# Verification report

Current, reproducible verification of PortfolioPilot. Updated at milestone 33 (2026-10-03).
Historical per-milestone results remain in [project-state.md](project-state.md); this file states
how to verify the system **now** and what that does and does not prove.

## The three commands

Run from the repository root with Node 24.21.0 / npm 11.19.0 after `npm ci`.

| Command | What it runs | Needs | Builds first |
| --- | --- | --- | --- |
| `npm run test:unit` | Every workspace's Vitest suite except `*.integration.test.ts`, plus the local-proxy `node:test` suite | Nothing else: no database, Redis, browser or credentials | `npm run build:types` |
| `npm run test:integration` | All 16 PostgreSQL/Redis acceptance suites, real worker processes, mock agent | Docker, **or** `TEST_POSTGRES_URL` + `TEST_REDIS_URL` | `build:types` + worker |
| `npm run test:browser` | All 17 Playwright spec files in Chrome against two API replicas, two agent workers and an outbox worker behind one origin (phases `main`, `limits`, `observability`, `outages`) | Docker (or the two URLs above) and Google Chrome | `npm run build` |
| `npm run eval:mock` | The versioned AI evaluation dataset through the deterministic mock agent (lesson 32) | Nothing else | agent workspace |
| `npm run eval:live -- --budget-usd <n>` | The same dataset against live Claude, optionally `--judge`; **billed** | `ANTHROPIC_API_KEY`, `EVAL_MODEL_ID` or `AGENT_MODEL_ID`, an explicit budget | agent workspace |

Each command prints a summary table, lists every **skipped** test by name, and exits `0` (all
passed), `1` (a failure) or `2` (a prerequisite is missing, so nothing was verified). A suite that runs
zero tests is reported as a failure, not a pass.

Options: `TEST_SKIP_BUILD=true` (reuse existing build output; refused if it is missing),
`TEST_KEEP_INFRA=true` (leave containers for inspection), `TEST_INTEGRATION_CONCURRENCY` (default
3), `TEST_BROWSER_TRACE=true` (keep Playwright traces of failures),
`TEST_BROWSER_SKIP_OUTAGES=true`. Arguments filter by name, for example
`npm run test:integration -- approvals outbox` or `npm run test:browser -- fanout chat`.

### Isolation and determinism

- **Disposable infrastructure.** By default each integration or browser run starts its own
  `postgres:17.6-alpine` and `redis:7.4.5-alpine` containers (the compose images) on free loopback
  ports and removes them at the end. Shared development services (`portfolio-pilot-local`, earlier
  `*_verify` containers) are never touched. In CI, set `TEST_POSTGRES_URL` (a maintenance database
  whose role may create and drop databases) and `TEST_REDIS_URL` (a test-only Redis; logical
  databases 1–15 are flushed).
- **One fresh database per suite.** A template database is migrated once with
  `prisma migrate deploy`. Every integration suite file, and every browser phase, gets its own
  `CREATE DATABASE … TEMPLATE` copy and its own flushed Redis logical database. Suites refuse any
  database that is not loopback and named `pp_test_*` (or the lesson's legacy `*_verify` name), via
  `tests/support/disposable-database.ts`.
- **Clocks.** Domain/property tests use fixed timestamps and fixed seeds; the demo seed uses its
  fixture clock; provider mocks are clock-driven, and the browser harness sets a shared
  `MOCK_START_AT` so both API replicas serve the same mock schedule. The session-expiry browser
  test controls the browser clock (`page.clock`). PostgreSQL and Redis timing rules use the
  servers' own clocks (`clock_timestamp()`, Redis `TIME`), which matters on Docker Desktop for
  Windows, where the container clock was measured about 0.85 s ahead of the host.
- **Mock agent and provider fixtures.** `AGENT_MODE=mock` and `DATA_MODE=mock` everywhere; recorded
  SDK and Alpaca fixtures are used by unit suites. No credential, paid API or network service is
  needed. The suites remove credential-like variables (`ANTHROPIC_API_KEY`, `ALPACA_*`,
  `RUN_LIVE_*`, other `DATABASE_URL`s) from their child environment.

## Latest results (2026-10-03, Windows 11, Docker Desktop, Chrome)

| Check | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run check:browser-boundary` | passed |
| `npm run test:unit` | **357 passed, 0 failed, 4 skipped** (the four live tests below) |
| `npm run test:integration` | **127 passed, 0 failed, 0 skipped** across 16 suites, each on its own database |
| `npm run test:browser` | **30 passed, 0 failed, 0 skipped**: main 26, limits 1, observability 2, outages 1 |
| `npm run eval:mock` | **gates 7/7 cases**, mean quality score 0.907 (see lesson 32 for the per-check table) |
| `npm run eval:live` | **not run**: no `ANTHROPIC_API_KEY` in this environment, and spending needs authorization |
| Collector configs | `otelcol-contrib:0.161.0 validate` exit 0 for both files; a deliberately broken copy exits 1 |
| OTLP → Jaeger 2.21.0 | Two linked spans exported over OTLP/HTTP and read back from `/api/v3/traces/<id>` |

### Skipped by design: live tests (not verified)

| Test | Opt-in | Needs |
| --- | --- | --- |
| `packages/agent/test/live-session-artifacts.test.ts` › LIVE Claude | `RUN_LIVE_SDK_RESTART=true` | `ANTHROPIC_API_KEY`, `AGENT_MODEL_ID` |
| `packages/agent/test/live-session-artifacts.test.ts` › LIVE Azure Blob | `RUN_LIVE_BLOB_ARTIFACTS=true` | existing private container, `SESSION_BLOB_CONTAINER_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE` |
| `packages/agent/test/research-comparison.live.test.ts` | `RUN_LIVE_RESEARCH_COMPARE=true` | Anthropic credentials (billed) |
| `packages/agent/test/skills.live.test.ts` | `RUN_LIVE_SKILLS_TEST=true` | Anthropic credentials (billed) |

Run one with, for example,
`RUN_LIVE_SDK_RESTART=true node node_modules/vitest/vitest.mjs run packages/agent/test/live-session-artifacts.test.ts -t "LIVE Claude"`
(lesson 28 has the PowerShell form). Live Alpaca market data and Microsoft Entra sign-in are also
unverified; they have no automated live test, only recorded-contract tests.

### Release images (milestone 33)

| Command | What it proves | Needs |
| --- | --- | --- |
| `npm run verify:containers` | Builds and starts `compose.production.yaml` under its own project, then runs eight checks: non-root / read-only / no-capability posture; read-only code with a writable SDK workspace; single origin (SPA fallback, caching, CSP, `/api` proxy, readiness); trade → outbox → Redis → SSE through nginx; question → agent worker → streamed answer → persisted message; a real Claude Code CLI turn against a local HTTP fixture in the API and worker images with `--network none`; production refusal of demo auth; SIGTERM drains every role to exit 0. Removes the stack afterwards | Docker, free port 8080 |
| `npm run inspect:images [-- --self-test]` | Every layer, the image config and the build history of all four images: no secrets (credential shapes and the literal values in local `.env` files or secret-named variables), `.env` files, transcripts, session artifacts, agent settings or source maps; browser assets free of server configuration. `--self-test` must detect seven planted violations | Docker, built images |

Results (2026-10-03, Windows 11, Docker Desktop 28.5.2, linux/amd64): `verify:containers` **8/8**,
`inspect:images` **PASS** (4 images), `--self-test` **7/7 detected**. linux/arm64 is not verified on this
machine (no emulation); `ci.yml` builds it natively. The workflows passed `actionlint` 1.7.12 but have not
run on GitHub (no remote repository here).

### Not part of the three commands

`npm run verify:distributed` (milestone 30) remains a separate, slower script: it kills API and
worker processes and stops dedicated containers repeatedly while it checks invariants. The browser
command covers cross-replica fan-out, and its outage phase covers the user-visible Redis/PostgreSQL
outage behavior.

## Critical invariants and where they are checked

U = unit, I = integration (real PostgreSQL/Redis), B = browser (two API replicas).

| Invariant | Tests |
| --- | --- |
| Decimal domain arithmetic | U `packages/domain/src/valuation.test.ts` (reference amounts, rounding), **`valuation.property.test.ts`** (600 seeded ledgers against an independent exact-rational model), `portfolio-facts`, `exposure`, `largest-holding`; I `portfolio` (ten-place amounts); B `portfolio.spec`, `fanout.spec` |
| Chronological oversell | U `valuation.test.ts`, `ledger.test.ts`, property test (≈20% deliberately oversold ledgers must be rejected); I `portfolio` (backdated changes against later sales, equal-time order), `outbox` (oversell rolls back its event) |
| Idempotency | I `portfolio` (simultaneous retries, key reuse), `outbox` (crash between publish and ack), `alerts` (concurrent/repeated delivery), `approvals`; U `db/outbox-cache` (UUID dedupe); B `article-recommendation.spec` (redelivered article), `fanout.spec` (answer shown once) |
| Concurrent sales | I `portfolio` › serializes conflicting concurrent sales and archive races; bounded lock retries |
| Ownership | I `auth`, `portfolio`, `agent-tools`, `chat`, `research`, `alerts`, `approvals`; U `events`, `tools`, `sdk-registration`, `security`; B foreign-ID 404s in `fanout`, `chat`, `research`, `alerts`, `approvals`, `article-recommendation`, `portfolio` |
| Authentication expiry | I `auth` › rejects expired database sessions; U `events` › closes on revocation/expiry; B **`session-expiry.spec`** (server-expired session signs the browser out and clears account data; the user's other session keeps working) |
| Provider normalization | U `providers/alpaca` (decimal digits, ambiguous identities, null URLs, window pinning), `providers/mock`, `api/market-service`; B `providers.spec` |
| Outbox rollback and retry | I `outbox` (atomic commit/rollback, bounded backoff, dead events), `operations` (audited requeue); U `worker/outbox` (fenced acknowledgement) |
| SSE replay and reset | U `api/events`, `events/route`, `web/stream-manager`; I `events` (two hubs, once per UUID), `outbox` (retention, trimmed/expired/foreign-epoch reset); B `streaming.spec`, `alerts.spec` (offline recovery), `chat.spec` (reload) |
| Partial/final text reconciliation | U `agent/streaming`, `api/agent-run-events`, `web/agent-runs`; I `chat` (recorded SDK fixtures: partial+final, duplicate frames); B `chat.spec`, `fanout.spec` |
| Approval consumption | I `approvals` (double click/concurrent consume → one mutation, expiry, cancellation race), `agent-jobs` (idempotent, fenced); U `agent/approvals`; B `approvals.spec` |
| Worker fencing | I `agent-jobs` (stale completion/heartbeat cannot overwrite), `operations` (recovery fences the hung worker), `ingestion` (replica fencing); U `worker/outbox` |
| Session artifact version conflicts | I `session-artifacts` (two workers racing, generation mismatch rolls back), `conversation-sessions` (compare-and-set); U `agent/session-artifacts` (simultaneous saves keep immutable versions) |

| AI evaluation checks can fail | U `packages/agent/test/eval.test.ts`: scripted adversarial agents trip injection, unsupported figure, unread citation, interpretation bounds, missing quote, privacy, stale-news and unreported-cost checks; the mock baseline passes every gate |
| Telemetry carries no user data | U `observability/telemetry.test.ts` (attribute/label allowlists, actor pseudonym, sanitizing exporter drops URLs/SQL/exception events from library spans, redacted logs), `prometheus.test.ts` (scraped labels allowlisted); B `observability.spec` (every exported attribute in both traces is exportable; no user ID, URL or query) |
| Trace continuity across durable hops | B **`observability.spec`**: article ingestion → fan-out → owner delivery → `sse.send` → event received by the page; API request → queued job → `agent.run` → `agent.tool` → `agent.message.persist` → outbox → `sse.send` → final message rendered; exact parent/child IDs across four processes |

### End-to-end scenarios (browser)

| Scenario | Spec |
| --- | --- |
| Portfolio creation and valuation | `portfolio.spec` (reference trades → exact holdings/valuation, liquidation, archive), `fanout.spec` (trade on replica 1 updates holdings viewed through replica 0) |
| New article → recommendation | **`article-recommendation.spec`**: ingestion CLI → running outbox worker → mock analysis → owner recommendation and alert, live over SSE; redelivery changes nothing; Bob gets nothing; `alerts.spec`, `research.spec` |
| Follow-up chat | `chat.spec` › follow-up continues the same assistant session |
| Explicit cancellation | `chat.spec` › Cancel answer; `approvals.spec`; `durable-workers.spec`; `budgets.spec` |
| Disconnect / reconnect | `chat.spec` › reload mid-answer; `alerts.spec` (offline, then recovery); `streaming.spec`; `durable-workers.spec`; `distributed-recovery.spec` (Redis/PostgreSQL outages) |
| Two-user isolation | `fanout.spec`, `portfolio.spec`, `news-live.spec`, `alerts.spec`, `research.spec`, `approvals.spec`, `article-recommendation.spec` |
| Two-API fan-out | **`fanout.spec`**: sessions are pinned to replica 0 or 1 (verified from the proxy's `x-pp-upstream` header); a portfolio and a trade accepted by one replica reach the owner's page on the other live; an answer requested through replica 0 streams to the conversation open on replica 1 exactly once; Bob, on either replica, receives nothing |

## Known limitations of this verification

- Single Windows host. Milestone 33 added `.github/workflows/ci.yml`, but it has not run yet: this
  workspace is not a Git repository and has no GitHub remote.
- Browser specs run sequentially (one Playwright worker) because they share the demo users' limits
  and state; the suite takes several minutes.
- During development of this milestone, one `outbox` integration run (out of 12) failed 5/9 tests
  and took 161 s. The output was not kept and it was not reproduced in 10 further runs. The other
  intermittent failure is understood and fixed (see lesson 31). Watch for recurrence.
- Live Claude, Azure Blob, Alpaca and Entra remain unverified (see the table above), and so do the
  live evaluation and the judge rubric (`npm run eval:live`) and export to a real Azure Monitor resource.
- Milestone 32: `chat.spec` › reloading mid-answer asserted `running` immediately after reload and
  failed in 2 of 4 runs with `queued` (a worker had not yet polled). It now asserts the actual
  invariant (not cancelled; `queued` or `running`; later `completed`). It passed 4/4 and in the final
  full run. Tracing overhead changing the timing was not ruled out.
