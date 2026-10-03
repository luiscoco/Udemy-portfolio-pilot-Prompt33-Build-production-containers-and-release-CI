# 0023. Distributed recovery and operational controls

- Status: Accepted
- Date: 2026-10-03
- Milestone: 30

## Context

Milestones 13–28 made state durable (PostgreSQL outbox, fenced agent leases, replayable Redis
Streams, signed SSE cursors) but every check ran one API and one worker. Production runs several
replicas that start, drain and die independently, and shared dependencies fail. We needed to show
that replica loss and dependency outages never produce duplicate financial mutations, cross-user
events or answers marked completed that did not complete, and to give operators bounded,
audited controls without adding an admin web surface.

## Decision

1. **Topology contract.** Any number of stateless API replicas behind one origin, any number of
   agent/outbox workers. Correctness never relies on stickiness: SSE cursors are HMAC-signed with
   the shared `AUTH_SECRET` (a named replica, `INSTANCE_ID`, now refuses to start without it) and
   every replica reads the same Redis Streams. A local Node proxy (`scripts/local-proxy.mjs`)
   models the gateway: readiness-based round-robin, streaming without buffering, and retry **only**
   when a request was provably not processed (connection refused, or a draining replica's explicit
   `x-portfolio-pilot-not-processed: draining` 503). A reset after sending is never replayed.
2. **One conversation, one execution.** Unchanged mechanism from ADR 0020 (conversation row lock,
   unique active-run index, fenced leases), now verified with two real API and two real worker
   processes.
3. **Bounded graceful shutdown.**
   - API: `apps/api/server.mjs` hosts Next.js through its documented programmatic server
     (`next({ dev: false, dir, hostname, port })`, `getRequestHandler`, `prepare`, verified against
     the installed `next/dist/server/next.d.ts` 16.3.8). On SIGTERM/SIGINT or an IPC `shutdown`
     message (Windows cannot deliver SIGTERM) it marks the replica draining: readiness returns 503,
     new requests get the not-processed 503, SSE streams close with `retry: 250` so browsers resume
     their cursor elsewhere, in-flight requests finish until `API_SHUTDOWN_GRACE_MS`, then
     connections and database/Redis clients close and the process exits (forced at the deadline).
   - Worker: draining stops claiming immediately; running work continues until
     `grace − min(5 s, grace/3)`, is then aborted and records a truthful `interrupted` outcome
     through the normal fenced finisher; the process exits at the grace deadline regardless. A job
     claimed but not yet started is handed back (`release`) instead of failed. A lost supervisor
     (IPC disconnect) triggers the same drain, so replicas are never orphaned.
   - Completed-turn session checkpoints (ADR 0021) are written before completion, so a run that
     finishes inside the drain window keeps its checkpoint; an aborted one has none and says so.
4. **Limits.** Per-user request windows (`api`, `agent_submit`) are fixed one-minute Redis counters
   shared by every replica, keyed by the database-verified owner. If Redis is unavailable each
   replica falls back to an in-memory window: degraded (N × limit), never unlimited. Per-user
   active-run admission (`AGENT_MAX_ACTIVE_RUNS_PER_USER`) is enforced in the PostgreSQL admission
   transaction under a per-owner advisory lock. Global agent concurrency
   (`AGENT_GLOBAL_CONCURRENCY`) is enforced in the claim transaction under one advisory lock that
   counts live leases; expired leases free their slot. Claims are therefore serialized cluster-wide,
   acceptable at this scale (short transactions, 500 ms poll).
5. **Monitoring and stuck jobs.** `operationsSnapshot` reports queue depth, oldest queued age, live
   leases, outbox pending/dead and ingestion state using database time only, without owner IDs or
   content. Stuck kinds: `expired_lease` (no worker reconciled it), `overrun` (still heartbeating
   past wall clock + grace: a hung execution), `queued_too_long`. Workers log the snapshot
   periodically and warn on stuck runs.
6. **Administrative recovery without a dashboard.** A CLI (`apps/worker/src/admin.ts`) runs inside
   the trusted network. Authorization requires an expiring (≤ 24 h), scoped operator credential
   (`ops:read`, `runs:recover`, `outbox:requeue`) whose SHA-256 is stored; the token is accepted only
   from `PORTFOLIO_ADMIN_TOKEN`. Issuing/revoking is break-glass (explicit `ADMIN_BOOTSTRAP`) and
   requires database authority, which is already the root of trust. Mutations require `--reason`
   and `--confirm <id>`. `recover-run` refuses healthy runs; for a stuck run it revokes the lease
   (fencing every later write by the old worker) and finishes it once as
   `failed:operator_recovered`. Every attempt, including denials, is written to `AdminAuditLog`,
   which a trigger makes append-only.
7. **Degrade versus stop.** Readiness fails only while draining or misconfigured; shared
   dependency outages report `degraded` with 200 so all replicas are not removed at once and users
   receive the API's honest per-request errors.

| Failure | Degrades (keeps working) | Stops | Recovery |
| --- | --- | --- | --- |
| Redis down | Reads, writes, trades, run submission/execution, snapshot recovery, rate limits (per replica) | Live SSE delivery and replay; cache | Outbox keeps events PENDING; delivery resumes; clients resync from snapshots |
| PostgreSQL down | Already-open SSE streams; static UI; readiness (`degraded`) | All reads/writes (503 "Nothing was changed"); agent progress and completion | Idempotent retries record once; in-flight runs end `failed:interrupted` after lease expiry |
| API replica lost | Other replicas; SSE resumes from signed cursor | Requests in flight on that replica | Proxy/gateway reroutes; refused requests are safe to retry |
| Worker lost | Other workers claim new work | Its running answers | Lease expiry → `interrupted`, never replayed after execution started |
| Retention expired/trimmed | Authoritative REST snapshot | Replay from the old cursor | `stream.reset` → `/api/events/recovery` |

## Consequences

- Production must run `server.mjs` (not `next start`) where bounded drain matters; milestone 33/35
  set the container command and a Kubernetes termination grace above both drain deadlines, plus a
  preStop delay so endpoint removal precedes SIGTERM.
- The admin database role can currently write `OperatorCredential`; milestone 34 should split the
  runtime role from a break-glass role and restrict `AdminAuditLog` to INSERT/SELECT (the trigger
  does not stop a table owner from `TRUNCATE`).
- Rate-limit windows use replica clocks for the window index; small skew only shifts boundaries.
- The local proxy is a test tool, not the production gateway (ADR for milestone 35 remains open).
