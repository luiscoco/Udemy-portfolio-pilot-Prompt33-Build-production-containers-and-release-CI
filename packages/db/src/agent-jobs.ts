import type { PrismaClient } from './generated/prisma/client.js';
import { assertRunFence, type RunFence } from './run-lease.js';
import { type AuthenticatedOwner, ownerForAgentRun } from './repositories.js';
import { chatService } from './chat-service.js';
import { authenticateRecoveryOwner } from './repositories.js';
export const AGENT_JOB_POLICY = { leaseMs: 30000, heartbeatMs: 5000, pollMs: 500, safeClaims: 3 } as const;
/** Transaction-scoped advisory lock serializing claims, so the global concurrency count cannot race. */
const CLAIM_LOCK = 30_000_001;
export type ClaimOptions = { runId?: string | null; globalConcurrency?: number };
/** Exact durable text for an attempt stopped by a worker loss. It never claims completion. */
export const INTERRUPTED_TEXT = 'This answer was interrupted when its worker stopped. It was not automatically replayed because it may have incurred cost or applied an approved change. Previously approved changes remain saved. Send a new request to continue.';
export function agentJobs(db: PrismaClient) {
 return {
  async claim(owner: string, options: string | null | ClaimOptions = null): Promise<RunFence | null> {
   const { runId = null, globalConcurrency } = typeof options === 'object' && options !== null ? options : { runId: options };
   return db.$transaction(async tx => {
    if (globalConcurrency !== undefined) {
     // Cluster-wide cap: live leases are counted under one lock; an expired lease frees its slot.
     await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${CLAIM_LOCK})`;
     const [active] = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM "AgentRun" WHERE "status" IN ('running','waiting_for_approval') AND "leaseUntil">clock_timestamp()`;
     if ((active?.count ?? 0) >= globalConcurrency) return null;
    }
    // Lock the conversation first, matching submission/completion. Unique active-run index is a backstop.
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT c."id" FROM "Conversation" c
      WHERE (c."leaseUntil" IS NULL OR c."leaseUntil"<=clock_timestamp())
      AND EXISTS (SELECT 1 FROM "AgentRun" r WHERE r."conversationId"=c."id" AND r."status"='queued' AND r."cancelRequestedAt" IS NULL AND (${runId}::text IS NULL OR r."id"=${runId}))
      ORDER BY c."updatedAt", c."id" LIMIT 1 FOR UPDATE OF c SKIP LOCKED`;
    if (!rows.length) return null;
    const runs = await tx.$queryRaw<{ id: string; attempt: number }[]>`UPDATE "AgentRun" SET "status"='running', "attempt"="attempt"+1,
      "leaseOwner"=${owner}, "leaseUntil"=clock_timestamp()+${AGENT_JOB_POLICY.leaseMs} * interval '1 millisecond', "heartbeatAt"=clock_timestamp()
      WHERE "id"=(SELECT "id" FROM "AgentRun" WHERE "conversationId"=${rows[0]!.id} AND "status"='queued' AND "cancelRequestedAt" IS NULL LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING "id", "attempt"`;
    if (!runs.length) return null;
    const run = runs[0]!;
    await tx.$executeRaw`UPDATE "Conversation" SET "leaseOwner"=${owner}, "leaseRunId"=${run.id}, "leaseUntil"=clock_timestamp()+${AGENT_JOB_POLICY.leaseMs} * interval '1 millisecond' WHERE "id"=${rows[0]!.id}`;
    return { runId: run.id, owner, attempt: run.attempt };
   });
  },
  async heartbeat(fence: RunFence, begin = false): Promise<'active' | 'cancelled'> {
   return db.$transaction(async tx => {
    const row = await tx.agentRun.findUniqueOrThrow({ where: { id: fence.runId } });
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${row.conversationId} FOR UPDATE`;
    await assertRunFence(tx, fence);
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: fence.runId } });
    await tx.$executeRaw`UPDATE "AgentRun" SET "heartbeatAt"=clock_timestamp(), "leaseUntil"=clock_timestamp()+${AGENT_JOB_POLICY.leaseMs} * interval '1 millisecond' WHERE "id"=${fence.runId}`;
    await tx.$executeRaw`UPDATE "Conversation" SET "leaseUntil"=clock_timestamp()+${AGENT_JOB_POLICY.leaseMs} * interval '1 millisecond' WHERE "id"=${run.conversationId}`;
    if (begin && !run.cancelRequestedAt) await tx.agentRun.update({ where: { id: run.id }, data: { executionStartedAt: new Date() } });
    return run.cancelRequestedAt ? 'cancelled' : 'active';
   });
  },
  async recover() {
   const candidates = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentRun" WHERE "status" IN ('running','waiting_for_approval') AND ("leaseUntil" IS NULL OR "leaseUntil"<=clock_timestamp()) ORDER BY "createdAt" LIMIT 20`;
   let recovered = 0;
   for (const candidate of candidates) {
    const safe = await db.$transaction(async tx => {
     const row = await tx.agentRun.findUnique({ where: { id: candidate.id } });
     if (!row) return false;
     await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${row.conversationId} FOR UPDATE`;
     const expired = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentRun" WHERE "id"=${row.id} AND "status" IN ('running','waiting_for_approval') AND ("leaseUntil" IS NULL OR "leaseUntil"<=clock_timestamp()) FOR UPDATE`;
     if (!expired.length) return false;
     const run = await tx.agentRun.findUniqueOrThrow({ where: { id: row.id } });
     if (run.executionStartedAt || run.cancelRequestedAt || run.nextSequence || run.attempt >= AGENT_JOB_POLICY.safeClaims || await tx.approvalRequest.count({ where: { runId: run.id } })) return false;
     await tx.agentRun.update({ where: { id: run.id }, data: { status: 'queued', leaseOwner: null, leaseUntil: null } });
     await tx.conversation.update({ where: { id: run.conversationId }, data: { leaseOwner: null, leaseUntil: null, leaseRunId: null } });
     return true;
    });
    if (safe) { recovered++; continue; }
    // Recheck expiry under the finisher's locks. A fresh heartbeat/claim wins over recovery.
    const owner = await authenticateRecoveryOwner(db, candidate.id);
    const result = await chatService(db, owner, undefined, true).finishRun(candidate.id, { status: 'failed', failureCode: 'interrupted',
      content: INTERRUPTED_TEXT, mode: null, instructionVersion: null, sources: [] });
    if (result) recovered++;
   }
   return recovered;
  },
  /**
   * Graceful-shutdown hand-back. A claimed attempt that never started executing (no begin
   * heartbeat, progress or approval) returns to the queue for another replica. Anything that may
   * have started stays with the caller, which must record a truthful interrupted outcome.
   */
  async release(fence: RunFence): Promise<'released' | 'started'> {
   return db.$transaction(async tx => {
    const row = await tx.agentRun.findUniqueOrThrow({ where: { id: fence.runId } });
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${row.conversationId} FOR UPDATE`;
    await assertRunFence(tx, fence);
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: fence.runId } });
    if (run.executionStartedAt || run.cancelRequestedAt || run.nextSequence || await tx.approvalRequest.count({ where: { runId: run.id } })) return 'started';
    await tx.agentRun.update({ where: { id: run.id }, data: { status: 'queued', leaseOwner: null, leaseUntil: null } });
    await tx.conversation.update({ where: { id: run.conversationId }, data: { leaseOwner: null, leaseUntil: null, leaseRunId: null } });
    return 'released';
   });
  },
  owner: (fence: RunFence): Promise<AuthenticatedOwner> => ownerForAgentRun(db, fence)
 };
}
