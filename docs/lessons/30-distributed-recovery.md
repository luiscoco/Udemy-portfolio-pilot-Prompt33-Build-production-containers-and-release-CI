# 30. Add distributed recovery and operational controls

Decision record: [ADR 0023](../decisions/0023-distributed-recovery-and-operational-controls.md).

## What works

- **Two API replicas and two agent workers behind one origin.** `npm run distributed:local` starts
  a local proxy on `:5320` (React build + `/api`), managed API replicas on `:5321`/`:5322`, two
  agent workers, an outbox dispatcher and mock ingestion. A user whose event stream is held by one
  replica receives events for work submitted through the other; nobody receives another user's
  events. One conversation never executes twice at once, whichever replica or worker is involved.
- **Bounded graceful shutdown.** API (`apps/api/server.mjs`): readiness becomes `draining` (503),
  new requests get a 503 marked *not processed* (safe to retry elsewhere), SSE streams close with a
  short retry hint and resume from their signed cursor on another replica, in-flight requests
  finish until `API_SHUTDOWN_GRACE_MS`, then clients close and the process exits. Worker: stops
  claiming, lets running answers finish, aborts what is still running ~5 s before the deadline so
  it records a truthful `interrupted` outcome, hands back claimed-but-unstarted jobs, then exits.
  SIGTERM, SIGINT, an IPC `shutdown` message (Windows) or a vanished supervisor all trigger this.
- **Limits.** Per-user request windows shared through Redis (`API_RATE_LIMIT_PER_MINUTE`,
  `AGENT_SUBMIT_RATE_LIMIT_PER_MINUTE`, 429 `RATE_LIMITED` + `Retry-After`), with a bounded
  per-replica fallback while Redis is down. Per-user active answers
  (`AGENT_MAX_ACTIVE_RUNS_PER_USER`) and cluster-wide live agent leases
  (`AGENT_GLOBAL_CONCURRENCY`) are enforced in PostgreSQL transactions; `AGENT_WORKER_CONCURRENCY`
  sets claim loops per worker.
- **Monitoring and stuck jobs.** Workers log an `operations.snapshot` (queue depth, oldest queued
  age, live leases, outbox pending/dead, ingestion state; no owners or content) and an
  `operations.stuck` warning for expired leases, overruns that still heartbeat, and long-queued work.
  Optional `WORKER_HEALTH_PORT` serves `/health/live` and `/health/ready`.
- **Audited administrative recovery, no dashboard.** `npm run admin --workspace=@portfolio-pilot/worker -- <command>`
  with an expiring, scoped operator token (environment only). `status`, `recover-run` (stuck runs
  only; fences the old worker; one truthful `failed:operator_recovered` outcome) and
  `requeue-outbox` (DEAD events only). Every attempt, including denials, lands in the append-only
  `AdminAuditLog`.
- **Understandable UI.** A service banner at the session gate explains Redis outages ("Live updates
  are paused … answers still finish and are saved"), database outages ("Saved data is temporarily
  unavailable … nothing is partially saved … interrupted, never completed"), restarting replicas and
  an unreachable service. A database outage no longer looks like a sign-out: only a 401 clears the
  session view.

### Degrade versus stop

| Failure | Keeps working | Stops | How it recovers |
| --- | --- | --- | --- |
| Redis | Reads, writes, trades, submitting and executing answers, snapshots, limits (per replica) | Live SSE and replay, cache | Outbox holds events in PostgreSQL and delivers after Redis returns; clients resync |
| PostgreSQL | Open SSE streams, static UI, readiness (`degraded`) | Every read/write (503 "Nothing was changed"), agent progress/completion | Idempotent retries record once; in-flight answers end `failed:interrupted` |
| One API replica | The other replica; streams resume from cursor | Requests in flight there | Proxy reroutes; refused requests retry safely |
| One worker | Other workers | Its running answers | Lease expiry → `interrupted` (never replayed once started) |
| Expired/trimmed stream | REST snapshot | Replay from the old cursor | `stream.reset` → `/api/events/recovery` |

## Changed files

- Created: `apps/api/server.mjs`, `apps/api/lib/{lifecycle,rate-limit}.ts` (+ tests),
  `apps/worker/src/{lifecycle,admin}.ts`, `apps/worker/test/{lifecycle.test,operations.integration.test}.ts`,
  `packages/db/src/{operations,admin}.ts`, migration `20261016100000_operational_controls`,
  `apps/web/src/service-status.tsx` (+ test), `apps/web/e2e/distributed-recovery.spec.ts`,
  `scripts/{local-proxy,local-proxy.test,distributed-local,verify-distributed}.mjs`, ADR 0023, this lesson.
- Modified: server config, contracts (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, readiness schema),
  Prisma schema, `agent-jobs` (global gate, `release`), `chat-service` (per-user admission,
  operator recovery of queued runs), `portfolio-service` (error code), `redis-keys`, API
  authorization/readiness/events/run submission/instrumentation/http helpers, worker entry and agent
  loop, web auth gate and stream status text, approvals integration test (raised per-user cap for
  its waiting fixtures), `.env.example` files, root and workspace `package.json` scripts.

## Check results and reproduction

Prerequisites: `npm ci --ignore-scripts --offline --cache .npm-cache`, `npm run build`. Dedicated,
disposable containers (outage tests stop them, so never point at shared services):

```powershell
docker run -d --name portfolio-pilot-m30-postgres -e POSTGRES_USER=portfolio_local -e POSTGRES_PASSWORD=local_only_change_me -e POSTGRES_DB=portfolio_m30_verify -p 127.0.0.1:5547:5432 postgres:17.6-alpine
docker run -d --name portfolio-pilot-m30-redis -p 127.0.0.1:6381:6379 redis:7.4.5-alpine redis-server --appendonly no
$env:DATABASE_URL='postgresql://portfolio_local:local_only_change_me@127.0.0.1:5547/portfolio_m30_verify'
npm run migrate:deploy --workspace=@portfolio-pilot/db
```

| Check | Command | Result (2026-10-03) |
| --- | --- | --- |
| Typecheck, build, browser boundary | `npm run typecheck`, `npm run build`, `npm run check:browser-boundary` | Passed |
| Unit tests | `npm run test` | 324 passed, 131 gated skips |
| Proxy retry-safety | `npm run test:proxy` | 6/6 |
| Operations on PostgreSQL + real worker processes | `$env:OPERATIONS_TEST_DATABASE_URL=$env:DATABASE_URL; node node_modules/vitest/vitest.mjs run --root apps/worker test/operations.integration.test.ts` | 11/11 |
| Distributed acceptance | see below | 11/11 scenarios, two consecutive runs |
| Browser outage states (Chrome) | see below | 1/1 |
| Earlier PostgreSQL suites after the migration | each suite's documented command | worker 50/50; API 91/91 |

```powershell
$env:DISTRIBUTED_TEST_DATABASE_URL=$env:DATABASE_URL
$env:DISTRIBUTED_TEST_REDIS_URL='redis://127.0.0.1:6381'
$env:DISTRIBUTED_PG_CONTAINER='portfolio-pilot-m30-postgres'
$env:DISTRIBUTED_REDIS_CONTAINER='portfolio-pilot-m30-redis'
npm run verify:distributed
```

Recorded scenario evidence: both replicas served traffic (7/7); both workers executed runs; maximum
live leases 3 with a global cap of 3; duplicate submissions to both replicas → one 202, one 409;
per-user cap → four 202 and one 429; the same idempotent trade sent to both replicas → one row
(`replayed` false/true); hard API kill → both proxy streams received every sequence of the next run;
graceful API drain → 20 reads and a trade during drain all succeeded (11 proxy retries of refused
requests), exit code 0; graceful worker drain completed its run; a killed worker's run became
`failed:interrupted` after the real 30 s lease (no fast-forward), attempt 1, never replayed;
Redis stopped → readiness `degraded`, streams reset `unavailable`, trade and answer still saved,
11 events held PENDING then delivered; trimmed and expired cursors reset to snapshots; PostgreSQL
stopped mid-answer → 503 with "Nothing was changed", every process survived, the retried trade
recorded once, the answer ended `failed:interrupted`; 40 submissions accepted across both replicas
before the shared limit of 40. Invariants: 4 trade keys → 4 rows; 26 completed + 2 interrupted
runs, each completed run with exactly one completed message and one completion event; no stream
contained another user's run, conversation or message ID.

Browser check (topology from `npm run distributed:local` with the same containers):

```powershell
$env:DISTRIBUTED_UI_BASE_URL='http://127.0.0.1:5320'
node node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts apps/web/e2e/distributed-recovery.spec.ts
```

Failures met while building this slice, all fixed and rerun: string edits failing on CRLF files;
a request body missing `currency`; trade responses are 200 with `replayed`, not 201; stored run
chunks are application events (with `payload`); a test timeout from a cold dynamic import; the
browser test's first run exceeded its total timeout during the Redis phase; and the approvals
suite's waiting fixtures exceeded the new default per-user cap.

## Demonstration

1. With the containers above: `$env:REDIS_URL='redis://127.0.0.1:6381'; $env:AUTH_SECRET='<32+ chars>'; npm run distributed:local`.
2. Open `http://127.0.0.1:5320`, sign in as Alice; in a second browser profile sign in as Bob.
   Ask the assistant a question in each; the answers stream although requests and streams land on
   different replicas, and neither user sees the other's activity.
3. `docker stop portfolio-pilot-m30-redis`: within ~15 s the "Live updates are paused" banner
   appears and the connection reads Offline; record a trade and ask a question, then **Refresh
   messages** to see the saved answer. `docker start` it: the banner clears and updates resume.
4. `docker stop portfolio-pilot-m30-postgres`: the red "Saved data is temporarily unavailable"
   alert appears and you stay signed in; a trade attempt reports that nothing was changed. Start it
   again and retry the same form: one transaction is recorded.
5. Operator flow (second terminal, same `DATABASE_URL`):
   ```powershell
   $env:ADMIN_BOOTSTRAP='issue'; $env:DATA_MODE='mock'
   npm run admin --workspace=@portfolio-pilot/worker -- issue-credential --operator oncall --scopes ops:read,runs:recover --ttl-minutes 60 --reason "Lesson 30 demo"
   Remove-Item Env:ADMIN_BOOTSTRAP; $env:PORTFOLIO_ADMIN_TOKEN='<token printed once>'
   npm run admin --workspace=@portfolio-pilot/worker -- status
   npm run admin --workspace=@portfolio-pilot/worker -- recover-run --run <stuck run id> --confirm <same id> --reason "Hung run after drain test"
   ```
   Recovering a healthy run is refused; both outcomes appear in `AdminAuditLog`.
6. Ctrl+C the launcher: every replica drains and exits.

## Remaining limitations and exercise

- Verified on one Windows host with loopback containers; no AKS, managed Redis/PostgreSQL failover
  or network partitions between replicas. Kubernetes probes, preStop delay and termination grace are
  milestone 35 work; the production container must run `server.mjs`.
- A PostgreSQL outage interrupts in-flight answers (lease expiry, up to 30 s after recovery); they
  are reported interrupted, never completed, and never automatically replayed.
- During a Redis outage limits are per replica; SSE clients poll durable state instead of streaming.
- Operator credential issuance relies on database authority; role separation and INSERT-only audit
  grants are deferred to milestone 34. No live Claude, Alpaca or Azure service was exercised.
- Exercise: add a `release-ingestion` admin command that clears a stuck ingestion lease only when
  `operationsSnapshot` shows it overdue, audited like `recover-run`, with an integration test.
