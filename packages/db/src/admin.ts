import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import { chatService } from './chat-service.js';
import { authenticateRecoveryOwner } from './repositories.js';
import { operationsSnapshot, type StuckKind, type StuckPolicy } from './operations.js';

/**
 * Administrative recovery (milestone 30). There is deliberately no HTTP surface: operators run a CLI
 * inside the trusted network with an expiring, scoped credential. Every attempt, including every
 * denial, is written to the append-only AdminAuditLog before the command reports anything.
 */
export const ADMIN_SCOPES = ['ops:read', 'runs:recover', 'outbox:requeue'] as const;
export type AdminScope = typeof ADMIN_SCOPES[number];
export const ADMIN_POLICY = { maxCredentialTtlMs: 24 * 3600000, tokenPrefix: 'ppop_' } as const;
export type DenialReason = 'invalid_credential' | 'expired' | 'revoked' | 'missing_scope' | 'invalid_request' | 'confirmation_mismatch' | 'not_found' | 'not_stuck' | 'not_dead';
export class AdminDenied extends Error {
  constructor(public readonly reason: DenialReason, message: string) { super(message); this.name = 'AdminDenied'; }
}
/** Durable user-visible text for an answer stopped by an operator. It never claims completion. */
export const OPERATOR_RECOVERED_TEXT = 'An operator stopped this answer during service recovery because it was not making progress. It was not automatically replayed. No trades were made. Previously approved changes remain saved; pending changes cannot execute. Send a new request to continue.';

const operatorBrand: unique symbol = Symbol('authorized-operator');
export type OperatorContext = Readonly<{ credentialId: string; operator: string; scopes: readonly AdminScope[]; [operatorBrand]: true }>;
const operators = new WeakSet<object>();
type Writer = PrismaClient | Prisma.TransactionClient;
type AuditEntry = { credentialId?: string | null; operator?: string | null; action: string; targetType?: string | null; targetId?: string | null; reason?: string | null;
  outcome: 'requested' | 'succeeded' | 'noop' | 'denied' | 'failed'; details?: Record<string, string | number | boolean | null> };

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATOR_NAME = /^[A-Za-z0-9_.@-]{1,64}$/;
/** Bounded, single-line audit reason; never a place for secrets, but also never unbounded input. */
export function auditReason(value: unknown): string {
  if (typeof value !== 'string') throw new AdminDenied('invalid_request', 'A --reason of 8 to 500 characters is required.');
  const reason = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (reason.length < 8 || reason.length > 500) throw new AdminDenied('invalid_request', 'A --reason of 8 to 500 characters is required.');
  return reason;
}
export async function writeAudit(db: Writer, entry: AuditEntry): Promise<void> {
  await db.adminAuditLog.create({ data: { id: randomUUID(), credentialId: entry.credentialId ?? null, operator: entry.operator ?? null, action: entry.action.slice(0, 64),
    targetType: entry.targetType ?? null, targetId: entry.targetId?.slice(0, 128) ?? null, reason: entry.reason?.slice(0, 500) ?? null, outcome: entry.outcome,
    ...(entry.details ? { details: entry.details } : {}) } });
}

/**
 * Break-glass issuance. Whoever can write OperatorCredential already holds database authority, so
 * this is the root of trust; it is audited and the token is returned exactly once.
 */
export async function issueOperatorCredential(db: PrismaClient, input: { operator: string; scopes: readonly string[]; ttlMs: number; reason: string }) {
  const reason = auditReason(input.reason);
  if (!OPERATOR_NAME.test(input.operator)) throw new AdminDenied('invalid_request', 'Operator names use 1-64 letters, digits, dot, dash, underscore or @.');
  const scopes = [...new Set(input.scopes)];
  if (!scopes.length || scopes.some(scope => !(ADMIN_SCOPES as readonly string[]).includes(scope))) throw new AdminDenied('invalid_request', `Scopes must be chosen from: ${ADMIN_SCOPES.join(', ')}.`);
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 60000 || input.ttlMs > ADMIN_POLICY.maxCredentialTtlMs) throw new AdminDenied('invalid_request', 'Credential lifetime must be between 1 minute and 24 hours.');
  const id = randomUUID(), token = ADMIN_POLICY.tokenPrefix + randomBytes(32).toString('base64url');
  return db.$transaction(async tx => {
    const [now] = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    const createdAt = now!.now, expiresAt = new Date(createdAt.getTime() + input.ttlMs);
    await tx.operatorCredential.create({ data: { id, operator: input.operator, tokenSha256: sha256(token), scopes, createdAt, expiresAt } });
    await writeAudit(tx, { credentialId: id, operator: input.operator, action: 'credential.issue', targetType: 'credential', targetId: id, reason, outcome: 'succeeded',
      details: { scopes: scopes.join(','), expiresAt: expiresAt.toISOString() } });
    return { id, operator: input.operator, scopes, expiresAt: expiresAt.toISOString(), token };
  });
}
export async function revokeOperatorCredential(db: PrismaClient, input: { credentialId: string; reason: string }) {
  const reason = auditReason(input.reason);
  if (!SAFE_ID.test(input.credentialId)) throw new AdminDenied('invalid_request', 'Invalid credential ID.');
  return db.$transaction(async tx => {
    const changed = await tx.operatorCredential.updateMany({ where: { id: input.credentialId, revokedAt: null }, data: { revokedAt: new Date() } });
    await writeAudit(tx, { credentialId: input.credentialId, action: 'credential.revoke', targetType: 'credential', targetId: input.credentialId, reason, outcome: changed.count ? 'succeeded' : 'noop' });
    return changed.count === 1;
  });
}

/** Verifies a presented token and the scope required for one action. Denials are audited. */
export async function authorizeOperator(db: PrismaClient, token: string | undefined, scope: AdminScope, attempt: { action: string; targetType?: string; targetId?: string }): Promise<OperatorContext> {
  const deny = async (reason: DenialReason, credential?: { id: string; operator: string }) => {
    await writeAudit(db, { credentialId: credential?.id ?? null, operator: credential?.operator ?? null, action: attempt.action, targetType: attempt.targetType ?? null,
      targetId: attempt.targetId && SAFE_ID.test(attempt.targetId) ? attempt.targetId : null, outcome: 'denied', details: { reason, scope } });
    return new AdminDenied(reason, reason === 'missing_scope' ? `This credential lacks the ${scope} scope.` : 'Operator credential is missing, invalid, expired or revoked.');
  };
  if (!token || !token.startsWith(ADMIN_POLICY.tokenPrefix) || token.length > 128) throw await deny('invalid_credential');
  const digest = sha256(token);
  const row = await db.operatorCredential.findUnique({ where: { tokenSha256: digest } });
  // The unique lookup is by digest; compare again in constant time before trusting it.
  if (!row || !timingSafeEqual(Buffer.from(row.tokenSha256), Buffer.from(digest))) throw await deny('invalid_credential');
  if (row.revokedAt) throw await deny('revoked', row);
  const [valid] = await db.$queryRaw<{ ok: boolean }[]>`SELECT ${row.expiresAt}::timestamptz > clock_timestamp() AS ok`;
  if (!valid?.ok) throw await deny('expired', row);
  if (!row.scopes.includes(scope)) throw await deny('missing_scope', row);
  await db.operatorCredential.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  const context: OperatorContext = Object.freeze({ credentialId: row.id, operator: row.operator, scopes: Object.freeze(row.scopes.filter((s): s is AdminScope => (ADMIN_SCOPES as readonly string[]).includes(s))), [operatorBrand]: true as const });
  operators.add(context);
  return context;
}

export function adminOperations(db: PrismaClient, operator: OperatorContext, policy: StuckPolicy) {
  if (!operators.has(operator)) throw new AdminDenied('invalid_credential', 'Operator context was not issued by authorizeOperator.');
  const who = { credentialId: operator.credentialId, operator: operator.operator };
  const require = (scope: AdminScope) => { if (!operator.scopes.includes(scope)) throw new AdminDenied('missing_scope', `This credential lacks the ${scope} scope.`); };
  async function denied(action: string, targetType: string, targetId: string | null, reason: string | null, denial: DenialReason, message: string, details: AuditEntry['details'] = {}): Promise<never> {
    await writeAudit(db, { ...who, action, targetType, targetId: targetId && SAFE_ID.test(targetId) ? targetId : null, reason, outcome: 'denied', details: { reason: denial, ...details } });
    throw new AdminDenied(denial, message);
  }
  return {
    async status() {
      require('ops:read');
      const snapshot = await operationsSnapshot(db, policy);
      await writeAudit(db, { ...who, action: 'ops.status', outcome: 'succeeded', details: { queued: snapshot.agentRuns.queued, stuck: snapshot.stuck.length, outboxDead: snapshot.outbox.dead } });
      return snapshot;
    },
    /**
     * Stops one stuck run with a truthful failed outcome. Only a run the stuck detector classifies
     * (expired lease, overrun while still heartbeating, or queued too long) is eligible; a healthy
     * run is refused. The lease is revoked first, so the old worker's fenced writes (progress,
     * approval consumption, completion) all fail; the terminal transition then happens exactly once.
     */
    async recoverRun(input: { runId: string; reason: unknown; confirm: string | undefined }) {
      require('runs:recover');
      const action = 'run.recover';
      let reason: string;
      try { reason = auditReason(input.reason); } catch (error) { return denied(action, 'agent_run', input.runId, null, 'invalid_request', (error as Error).message); }
      if (!SAFE_ID.test(input.runId)) return denied(action, 'agent_run', null, reason, 'invalid_request', 'Invalid run ID.');
      if (input.confirm !== input.runId) return denied(action, 'agent_run', input.runId, reason, 'confirmation_mismatch', 'Repeat the run ID with --confirm to apply this change.');
      const classified = await db.$transaction(async tx => {
        const target = await tx.agentRun.findUnique({ where: { id: input.runId }, select: { conversationId: true } });
        if (!target) return null;
        await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${target.conversationId} FOR UPDATE`;
        const [row] = await tx.$queryRaw<{ status: string; attempt: number; started: boolean; kind: StuckKind | null }[]>`
          SELECT "status", "attempt", "executionStartedAt" IS NOT NULL AS started, CASE
            WHEN "status" IN ('running','waiting_for_approval') AND ("leaseUntil" IS NULL OR "leaseUntil" <= clock_timestamp()) THEN 'expired_lease'
            WHEN "status" = 'running' AND "executionStartedAt" <= clock_timestamp() - ${policy.wallClockMs + policy.runningGraceMs} * interval '1 millisecond' THEN 'overrun'
            WHEN "status" = 'queued' AND "createdAt" <= clock_timestamp() - ${policy.queuedMs} * interval '1 millisecond' THEN 'queued_too_long'
            ELSE NULL END AS kind
          FROM "AgentRun" WHERE "id"=${input.runId} FOR UPDATE`;
        if (!row || !row.kind) return { row: row ?? null, kind: null };
        // Revoke the lease: every fenced write by the previous attempt now fails.
        await tx.$executeRaw`UPDATE "AgentRun" SET "leaseUntil"=clock_timestamp() - interval '1 millisecond' WHERE "id"=${input.runId} AND "status" IN ('running','waiting_for_approval')`;
        await tx.$executeRaw`UPDATE "Conversation" SET "leaseUntil"=clock_timestamp() - interval '1 millisecond' WHERE "id"=${target.conversationId} AND "leaseRunId"=${input.runId}`;
        await writeAudit(tx, { ...who, action, targetType: 'agent_run', targetId: input.runId, reason, outcome: 'requested', details: { kind: row.kind, status: row.status, attempt: row.attempt } });
        return { row, kind: row.kind };
      });
      if (!classified) return denied(action, 'agent_run', input.runId, reason, 'not_found', 'Run not found.');
      if (!classified.kind) return denied(action, 'agent_run', input.runId, reason, 'not_stuck', 'This run is not stuck; recovery was refused. Use the status command to list stuck runs.', { status: classified.row?.status ?? null });
      try {
        const owner = await authenticateRecoveryOwner(db, input.runId);
        const notStarted = classified.row!.status === 'queued' && !classified.row!.started;
        const finished = await chatService(db, owner, undefined, true).finishRun(input.runId, { status: 'failed', failureCode: 'operator_recovered', content: OPERATOR_RECOVERED_TEXT,
          mode: null, instructionVersion: null, sources: [], ...(notStarted ? { usage: { accounting: 'not_started' as const, estimatedCostUsd: '0.000000', aggregateTokens: 0, turns: 0, resultCount: 0 } } : {}) });
        // null: a worker's own recovery or a fresh claim settled it first; nothing was overwritten.
        await writeAudit(db, { ...who, action, targetType: 'agent_run', targetId: input.runId, reason, outcome: finished ? 'succeeded' : 'noop', details: { kind: classified.kind, finalStatus: finished?.run.status ?? null } });
        return { runId: input.runId, kind: classified.kind, outcome: finished ? 'failed:operator_recovered' as const : 'already_settled' as const };
      } catch (error) {
        await writeAudit(db, { ...who, action, targetType: 'agent_run', targetId: input.runId, reason, outcome: 'failed', details: { error: error instanceof Error ? error.name : 'unknown' } });
        throw error;
      }
    },
    /** Returns a DEAD outbox event to delivery with the same UUID, so consumers still deduplicate it. */
    async requeueOutboxEvent(input: { eventId: string; reason: unknown; confirm: string | undefined }) {
      require('outbox:requeue');
      const action = 'outbox.requeue';
      let reason: string;
      try { reason = auditReason(input.reason); } catch (error) { return denied(action, 'outbox_event', input.eventId, null, 'invalid_request', (error as Error).message); }
      if (!/^[0-9a-f-]{36}$/.test(input.eventId)) return denied(action, 'outbox_event', null, reason, 'invalid_request', 'Invalid event ID.');
      if (input.confirm !== input.eventId) return denied(action, 'outbox_event', input.eventId, reason, 'confirmation_mismatch', 'Repeat the event ID with --confirm to apply this change.');
      // The change and its audit row commit together.
      const requeued = await db.$transaction(async tx => {
        const moved = await tx.$executeRaw`UPDATE "OutboxEvent" SET "status"='PENDING', "attempts"=0, "availableAt"=clock_timestamp(), "lastError"=NULL WHERE "id"=${input.eventId}::uuid AND "status"='DEAD'`;
        if (moved === 1) await writeAudit(tx, { ...who, action, targetType: 'outbox_event', targetId: input.eventId, reason, outcome: 'succeeded' });
        return moved === 1;
      });
      if (!requeued) return denied(action, 'outbox_event', input.eventId, reason, 'not_dead', 'Only DEAD outbox events can be requeued.');
      return { eventId: input.eventId, outcome: 'requeued' as const };
    }
  };
}
