import type { PrismaClient } from './generated/prisma/client.js';

/**
 * Thresholds for stuck-job detection. A run is "overrun" when it has executed for longer than the
 * agent wall clock plus a grace period while its lease is still being renewed: the heartbeat timer
 * is alive but the execution never settled (a hung SDK call or tool). Expired leases are normally
 * reconciled by any worker's recovery pass, so one that persists means no agent worker is running.
 */
export type StuckPolicy = { wallClockMs: number; runningGraceMs: number; queuedMs: number; expiredLeaseGraceMs?: number };
export type StuckKind = 'expired_lease' | 'overrun' | 'queued_too_long';
export type StuckRun = { kind: StuckKind; runId: string; conversationId: string; status: string; attempt: number; ageMs: number };
/**
 * Aggregate, tenant-free operational view. Run and conversation IDs are opaque; no owner, prompt,
 * answer or credential is included, so the snapshot is safe to log and to show to an operator.
 */
export type OperationsSnapshot = {
  observedAt: string;
  agentRuns: { queued: number; running: number; waitingForApproval: number; liveLeases: number; oldestQueuedAgeMs: number | null };
  outbox: { pending: number; dead: number; oldestPendingAgeMs: number | null };
  ingestion: { key: string; failures: number; leaseActive: boolean; overdueMs: number }[];
  stuck: StuckRun[];
};

const age = (value: unknown) => value === null || value === undefined ? null : Math.max(0, Math.round(Number(value)));

export async function findStuckRuns(db: PrismaClient, policy: StuckPolicy, limit = 50): Promise<StuckRun[]> {
  const expiredGrace = policy.expiredLeaseGraceMs ?? 5000;
  // Database time only: replica clocks never decide whether work is stuck.
  const rows = await db.$queryRaw<{ kind: StuckKind; id: string; conversationId: string; status: string; attempt: number; age_ms: number }[]>`
    SELECT * FROM (
      SELECT 'expired_lease' AS kind, "id", "conversationId", "status", "attempt",
        EXTRACT(EPOCH FROM clock_timestamp() - COALESCE("leaseUntil", "createdAt")) * 1000 AS age_ms
      FROM "AgentRun" WHERE "status" IN ('running','waiting_for_approval')
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= clock_timestamp() - ${expiredGrace} * interval '1 millisecond')
      UNION ALL
      SELECT 'overrun', "id", "conversationId", "status", "attempt",
        EXTRACT(EPOCH FROM clock_timestamp() - "executionStartedAt") * 1000
      FROM "AgentRun" WHERE "status" = 'running' AND "leaseUntil" > clock_timestamp() AND "executionStartedAt" IS NOT NULL
        AND "executionStartedAt" <= clock_timestamp() - ${policy.wallClockMs + policy.runningGraceMs} * interval '1 millisecond'
      UNION ALL
      SELECT 'queued_too_long', "id", "conversationId", "status", "attempt",
        EXTRACT(EPOCH FROM clock_timestamp() - "createdAt") * 1000
      FROM "AgentRun" WHERE "status" = 'queued' AND "cancelRequestedAt" IS NULL
        AND "createdAt" <= clock_timestamp() - ${policy.queuedMs} * interval '1 millisecond'
    ) stuck ORDER BY age_ms DESC, "id" LIMIT ${limit}`;
  return rows.map(row => ({ kind: row.kind, runId: row.id, conversationId: row.conversationId, status: row.status, attempt: row.attempt, ageMs: age(row.age_ms) ?? 0 }));
}

export async function operationsSnapshot(db: PrismaClient, policy: StuckPolicy): Promise<OperationsSnapshot> {
  const [runs] = await db.$queryRaw<{ queued: number; running: number; waiting: number; live: number; oldest_queued_ms: number | null }[]>`
    SELECT count(*) FILTER (WHERE "status"='queued')::int AS queued,
      count(*) FILTER (WHERE "status"='running')::int AS running,
      count(*) FILTER (WHERE "status"='waiting_for_approval')::int AS waiting,
      count(*) FILTER (WHERE "status" IN ('running','waiting_for_approval') AND "leaseUntil" > clock_timestamp())::int AS live,
      EXTRACT(EPOCH FROM clock_timestamp() - min("createdAt") FILTER (WHERE "status"='queued')) * 1000 AS oldest_queued_ms
    FROM "AgentRun" WHERE "status" IN ('queued','running','waiting_for_approval')`;
  const [outbox] = await db.$queryRaw<{ pending: number; dead: number; oldest_pending_ms: number | null }[]>`
    SELECT count(*) FILTER (WHERE "status"='PENDING')::int AS pending, count(*) FILTER (WHERE "status"='DEAD')::int AS dead,
      EXTRACT(EPOCH FROM clock_timestamp() - min("createdAt") FILTER (WHERE "status"='PENDING')) * 1000 AS oldest_pending_ms
    FROM "OutboxEvent" WHERE "status" IN ('PENDING','DEAD')`;
  const ingestion = await db.$queryRaw<{ key: string; failures: number; active: boolean; overdue_ms: number }[]>`
    SELECT "key", "failures", COALESCE("leaseUntil" > clock_timestamp(), false) AS active,
      GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - "nextRunAt") * 1000) AS overdue_ms
    FROM "IngestionState" ORDER BY "key" LIMIT 20`;
  const [now] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return {
    observedAt: (now?.now ?? new Date()).toISOString(),
    agentRuns: { queued: runs?.queued ?? 0, running: runs?.running ?? 0, waitingForApproval: runs?.waiting ?? 0, liveLeases: runs?.live ?? 0, oldestQueuedAgeMs: age(runs?.oldest_queued_ms) },
    outbox: { pending: outbox?.pending ?? 0, dead: outbox?.dead ?? 0, oldestPendingAgeMs: age(outbox?.oldest_pending_ms) },
    ingestion: ingestion.map(row => ({ key: row.key.slice(0, 64), failures: row.failures, leaseActive: row.active, overdueMs: age(row.overdue_ms) ?? 0 })),
    stuck: await findStuckRuns(db, policy)
  };
}
