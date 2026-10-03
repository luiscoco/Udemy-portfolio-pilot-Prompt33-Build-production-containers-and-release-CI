import { isDisposableDatabase } from '../../../tests/support/disposable-database';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminDenied, adminOperations, agentJobs, authenticateOwner, authorizeOperator, chatService, closeConnections, findStuckRuns, getDatabase,
  issueOperatorCredential, operationsSnapshot, ownerForAgentRun, revokeOperatorCredential, type RunFence, type RunOutcome } from '@portfolio-pilot/db';
import { runAdmin } from '../src/admin.js';

/**
 * Milestone 30 acceptance against real PostgreSQL and real worker processes. Requires a dedicated,
 * migrated loopback database named portfolio_m30_verify (see docs/lessons/30-distributed-recovery.md).
 */
const url = process.env.OPERATIONS_TEST_DATABASE_URL;
const completed: RunOutcome = { status: 'completed', failureCode: null, content: 'Saved answer', mode: 'mock', instructionVersion: null, sources: [], usage: { accounting: 'mock', estimatedCostUsd: '0.000000', aggregateTokens: 0, turns: 0, resultCount: 0 } };
const policy = { wallClockMs: 1000, runningGraceMs: 1000, queuedMs: 60000 };
describe.skipIf(!url)('operational controls on PostgreSQL', () => {
 let db: Awaited<ReturnType<typeof getDatabase>>;
 let jobs: ReturnType<typeof agentJobs>;
 const users: string[] = [], children: ChildProcess[] = [];
 beforeAll(async () => {
  const parsed = new URL(url!);
  if (!isDisposableDatabase(parsed, ['portfolio_m30_verify'])) throw new Error('Use the dedicated loopback portfolio_m30_verify database.');
  db = await getDatabase(url!); jobs = agentJobs(db);
 });
 // Each scenario starts from a quiet queue, so claims can only see that scenario's own jobs.
 beforeEach(async () => {
  await db.agentRun.updateMany({ where: { status: { in: ['queued', 'running', 'waiting_for_approval'] } }, data: { status: 'cancelled', completedAt: new Date(), leaseOwner: null, leaseUntil: null } });
  await db.conversation.updateMany({ where: { leaseRunId: { not: null } }, data: { leaseOwner: null, leaseUntil: null, leaseRunId: null } });
 });
 afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  if (db) await db.user.deleteMany({ where: { id: { in: users } } });
  await closeConnections();
 });
 async function user() {
  const id = 'm30-' + randomUUID(); users.push(id);
  await db.user.create({ data: { id, name: 'Operations test', email: `${id}@example.invalid` } });
  await db.session.create({ data: { id, userId: id, token: id, expiresAt: new Date(Date.now() + 600000) } });
  const owner = await authenticateOwner(db, id);
  return { id, owner, chat: chatService(db, owner) };
 }
 async function submit(u: Awaited<ReturnType<typeof user>>, maxActiveRuns?: number, conversationId?: string) {
  const conversation = conversationId ?? (await u.chat.create({})).id;
  return u.chat.startRun(conversation, { runId: randomUUID(), assistantMessageId: randomUUID(), content: 'Explain my holdings', ...(maxActiveRuns ? { maxActiveRuns } : {}) });
 }
 async function finish(fence: RunFence, outcome = completed) { return chatService(db, await ownerForAgentRun(db, fence), fence).finishRun(fence.runId, outcome); }
 async function liveLeases() { return db.agentRun.count({ where: { status: { in: ['running', 'waiting_for_approval'] }, leaseUntil: { gt: new Date() } } }); }

 it('caps live agent leases cluster-wide even when many replicas claim at once', async () => {
  const u = await user();
  for (let n = 0; n < 6; n++) await submit(u);
  const cap = (await liveLeases()) + 3;
  const fences = (await Promise.all(Array.from({ length: 8 }, (_, n) => jobs.claim(`replica-${n}`, { globalConcurrency: cap })))).filter((f): f is RunFence => f !== null);
  expect(fences).toHaveLength(3);
  expect(await liveLeases()).toBe(cap);
  expect(await jobs.claim('replica-x', { globalConcurrency: cap })).toBeNull();
  await finish(fences[0]!);
  const next = await jobs.claim('replica-y', { globalConcurrency: cap });
  expect(next).not.toBeNull();
  // A dead replica's expired lease frees its slot instead of blocking the cluster forever.
  await db.agentRun.update({ where: { id: fences[1]!.runId }, data: { leaseUntil: new Date(0) } });
  expect(await jobs.claim('replica-z', { globalConcurrency: cap })).not.toBeNull();
  for (const row of await db.agentRun.findMany({ where: { conversation: { ownerId: u.id }, status: { in: ['queued', 'running'] } } })) await u.chat.requestCancel(row.id).catch(() => undefined);
 });
 it('caps active runs per user under concurrent admission on different conversations; other users are unaffected', async () => {
  const alice = await user(), bob = await user();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => submit(alice, 2)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  expect(rejected.map(r => [r.reason.status, r.reason.code])).toEqual([[429, 'RATE_LIMITED'], [429, 'RATE_LIMITED']]);
  expect(rejected[0]!.reason.message).toContain('in progress');
  expect(await db.agentRun.count({ where: { conversation: { ownerId: alice.id } } })).toBe(2);
  // Rejected admissions left no user message or budget reservation behind.
  expect(await db.chatMessage.count({ where: { conversation: { ownerId: alice.id } } })).toBe(2);
  expect((await db.dailyAgentBudget.findFirstOrThrow({ where: { ownerId: alice.id } })).reservedUsd.toFixed(6)).toBe('0.400000');
  expect((await submit(bob, 2)).run.status).toBe('queued');
 });
 it('never admits or claims one conversation twice, whichever replica asks', async () => {
  const u = await user(), conversation = await u.chat.create({});
  const admissions = await Promise.allSettled(Array.from({ length: 4 }, () => submit(u, 10, conversation.id)));
  expect(admissions.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const mine = await db.agentRun.findMany({ where: { conversationId: conversation.id } });
  expect(mine).toHaveLength(1);
  const claims = await Promise.all(Array.from({ length: 4 }, (_, n) => jobs.claim(`c-${n}`, { runId: mine[0]!.id, globalConcurrency: 1000 })));
  expect(claims.filter(f => f?.runId === mine[0]!.id)).toHaveLength(1);
  await finish(claims.find(f => f?.runId === mine[0]!.id)!);
 });
 it('releases an unstarted claim back to the queue but never a started attempt', async () => {
  const u = await user(), started = await submit(u);
  const first = (await jobs.claim('draining', started.run.id))!;
  expect(await jobs.release(first)).toBe('released');
  expect((await u.chat.getRun(started.run.id)).status).toBe('queued');
  const second = (await jobs.claim('healthy', started.run.id))!;
  expect(second.attempt).toBe(2);
  await jobs.heartbeat(second, true);
  expect(await jobs.release(second)).toBe('started');
  expect((await u.chat.getRun(started.run.id)).status).toBe('running');
  await expect(jobs.release(first)).rejects.toMatchObject({ status: 409 });
  await finish(second);
 });
 it('detects expired leases, overruns that still heartbeat, and queued work that waits too long', async () => {
  const u = await user();
  const expired = await submit(u), overrun = await submit(u), queued = await submit(u);
  const e = (await jobs.claim('dead-worker', expired.run.id))!; await jobs.heartbeat(e, true);
  await db.agentRun.update({ where: { id: e.runId }, data: { leaseUntil: new Date(Date.now() - 60000) } });
  const o = (await jobs.claim('hung-worker', overrun.run.id))!; await jobs.heartbeat(o, true);
  await db.agentRun.update({ where: { id: o.runId }, data: { executionStartedAt: new Date(Date.now() - 600000) } });
  await db.agentRun.update({ where: { id: queued.run.id }, data: { createdAt: new Date(Date.now() - 3600000) } });
  const stuck = await findStuckRuns(db, policy, 1000);
  const kind = (id: string) => stuck.find(s => s.runId === id)?.kind;
  expect([kind(expired.run.id), kind(overrun.run.id), kind(queued.run.id)]).toEqual(['expired_lease', 'overrun', 'queued_too_long']);
  const snapshot = await operationsSnapshot(db, policy);
  expect(snapshot.agentRuns.queued).toBeGreaterThanOrEqual(1);
  expect(snapshot.agentRuns.oldestQueuedAgeMs).toBeGreaterThan(3500000);
  expect(JSON.stringify(snapshot)).not.toContain(u.id);
  expect(JSON.stringify(snapshot)).not.toContain('Explain my holdings');
  for (const id of [overrun.run.id, queued.run.id]) await db.agentRun.update({ where: { id }, data: { createdAt: new Date() } });
  await finish(o);
  await jobs.recover(); // expired lease -> truthful interruption
  expect(await u.chat.getRun(expired.run.id)).toMatchObject({ status: 'failed', failureCode: 'interrupted' });
  await u.chat.requestCancel(queued.run.id);
 });
 it('admin access requires a valid, unexpired, unrevoked, scoped credential and audits every denial', async () => {
  const before = await db.adminAuditLog.count();
  await expect(authorizeOperator(db, undefined, 'ops:read', { action: 'status' })).rejects.toMatchObject({ reason: 'invalid_credential' });
  await expect(authorizeOperator(db, 'ppop_forged', 'ops:read', { action: 'status' })).rejects.toMatchObject({ reason: 'invalid_credential' });
  const reader = await issueOperatorCredential(db, { operator: 'ops.reader', scopes: ['ops:read'], ttlMs: 600000, reason: 'Milestone 30 acceptance test' });
  expect(reader.token).toMatch(/^ppop_/);
  expect(await db.operatorCredential.count({ where: { tokenSha256: { contains: reader.token } } })).toBe(0);
  const context = await authorizeOperator(db, reader.token, 'ops:read', { action: 'status' });
  expect((await adminOperations(db, context, policy).status()).agentRuns).toBeDefined();
  await expect(authorizeOperator(db, reader.token, 'runs:recover', { action: 'recover-run', targetType: 'agent_run', targetId: 'x' })).rejects.toMatchObject({ reason: 'missing_scope' });
  await expect(adminOperations(db, context, policy).recoverRun({ runId: 'x', confirm: 'x', reason: 'not allowed scope' })).rejects.toBeInstanceOf(AdminDenied);
  const expired = await issueOperatorCredential(db, { operator: 'ops.expired', scopes: ['ops:read'], ttlMs: 60000, reason: 'Milestone 30 expiry test' });
  await db.operatorCredential.update({ where: { id: expired.id }, data: { createdAt: new Date(Date.now() - 7200000), expiresAt: new Date(Date.now() - 3600000) } });
  await expect(authorizeOperator(db, expired.token, 'ops:read', { action: 'status' })).rejects.toMatchObject({ reason: 'expired' });
  expect(await revokeOperatorCredential(db, { credentialId: reader.id, reason: 'Milestone 30 revocation test' })).toBe(true);
  await expect(authorizeOperator(db, reader.token, 'ops:read', { action: 'status' })).rejects.toMatchObject({ reason: 'revoked' });
  await expect(issueOperatorCredential(db, { operator: 'ops', scopes: ['admin:*'], ttlMs: 600000, reason: 'invalid scope request' })).rejects.toMatchObject({ reason: 'invalid_request' });
  await expect(issueOperatorCredential(db, { operator: 'ops', scopes: ['ops:read'], ttlMs: 48 * 3600000, reason: 'too long lifetime' })).rejects.toMatchObject({ reason: 'invalid_request' });
  const audit = await db.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' }, skip: before });
  expect(audit.filter(a => a.outcome === 'denied').map(a => (a.details as { reason: string }).reason)).toEqual(['invalid_credential', 'invalid_credential', 'missing_scope', 'expired', 'revoked']);
  expect(audit.some(a => a.action === 'ops.status' && a.outcome === 'succeeded' && a.operator === 'ops.reader')).toBe(true);
  expect(JSON.stringify(audit)).not.toContain(reader.token);
  // Append-only: the application role cannot rewrite or erase history.
  await expect(db.adminAuditLog.update({ where: { id: audit[0]!.id }, data: { outcome: 'succeeded' } })).rejects.toThrow();
  await expect(db.adminAuditLog.deleteMany({})).rejects.toThrow();
 });
 it('recovers only stuck runs: fences the hung worker, records a truthful failure exactly once and keeps the budget conservative', async () => {
  const u = await user(), healthy = await submit(u), hung = await submit(u);
  const recoverer = await issueOperatorCredential(db, { operator: 'ops.oncall', scopes: ['ops:read', 'runs:recover'], ttlMs: 600000, reason: 'Milestone 30 recovery test' });
  const ops = adminOperations(db, await authorizeOperator(db, recoverer.token, 'runs:recover', { action: 'recover-run' }), policy);
  const h = (await jobs.claim('healthy-worker', healthy.run.id))!; await jobs.heartbeat(h, true);
  const stale = (await jobs.claim('hung-worker', hung.run.id))!; await jobs.heartbeat(stale, true);
  await db.agentRun.update({ where: { id: hung.run.id }, data: { executionStartedAt: new Date(Date.now() - 600000) } });
  await expect(ops.recoverRun({ runId: healthy.run.id, confirm: healthy.run.id, reason: 'Attempt on a healthy run' })).rejects.toMatchObject({ reason: 'not_stuck' });
  expect((await u.chat.getRun(healthy.run.id)).status).toBe('running');
  await expect(ops.recoverRun({ runId: hung.run.id, confirm: 'wrong', reason: 'Missing confirmation' })).rejects.toMatchObject({ reason: 'confirmation_mismatch' });
  await expect(ops.recoverRun({ runId: hung.run.id, confirm: hung.run.id, reason: 'short' })).rejects.toMatchObject({ reason: 'invalid_request' });
  const result = await ops.recoverRun({ runId: hung.run.id, confirm: hung.run.id, reason: 'Run exceeded its wall clock while heartbeating' });
  expect(result).toEqual({ runId: hung.run.id, kind: 'overrun', outcome: 'failed:operator_recovered' });
  // The hung worker wakes up: every fenced write fails, so it cannot complete or charge twice.
  await expect(jobs.heartbeat(stale)).rejects.toMatchObject({ status: 409 });
  await expect(finish(stale)).rejects.toThrow();
  const run = await u.chat.getRun(hung.run.id);
  expect(run).toMatchObject({ status: 'failed', failureCode: 'operator_recovered', usage: { accounting: 'conservative' } });
  const messages = await db.chatMessage.findMany({ where: { id: hung.run.assistantMessageId } });
  expect(messages).toHaveLength(1); expect(messages[0]!.content).toContain('An operator stopped this answer'); expect(messages[0]!.status).toBe('failed');
  expect(await db.outboxEvent.count({ where: { entityId: hung.run.id, type: 'agent.run.completed' } })).toBe(1);
  // Repeating the command cannot produce a second outcome.
  await expect(ops.recoverRun({ runId: hung.run.id, confirm: hung.run.id, reason: 'Repeated recovery attempt' })).rejects.toMatchObject({ reason: 'not_stuck' });
  const trail = await db.adminAuditLog.findMany({ where: { targetId: hung.run.id }, orderBy: { createdAt: 'asc' } });
  expect(trail.map(a => a.outcome)).toEqual(['denied', 'denied', 'requested', 'succeeded', 'denied']);
  expect(trail.every(a => a.operator === 'ops.oncall' || a.outcome === 'denied')).toBe(true);
  await finish(h);
 });
 it('recovers a queued job that waited too long without charging it', async () => {
  const u = await user(), queued = await submit(u);
  await db.agentRun.update({ where: { id: queued.run.id }, data: { createdAt: new Date(Date.now() - 3600000) } });
  const cred = await issueOperatorCredential(db, { operator: 'ops.queue', scopes: ['runs:recover'], ttlMs: 600000, reason: 'Milestone 30 queue test' });
  const ops = adminOperations(db, await authorizeOperator(db, cred.token, 'runs:recover', { action: 'recover-run' }), policy);
  expect((await ops.recoverRun({ runId: queued.run.id, confirm: queued.run.id, reason: 'No worker capacity for an hour' })).kind).toBe('queued_too_long');
  expect(await u.chat.getRun(queued.run.id)).toMatchObject({ status: 'failed', failureCode: 'operator_recovered', usage: { accounting: 'not_started' } });
  expect((await db.dailyAgentBudget.findFirstOrThrow({ where: { ownerId: u.id } })).chargedUsd.toFixed(6)).toBe('0.000000');
 });
 it('requeues only DEAD outbox events, atomically audited, through the CLI', async () => {
  const u = await user();
  const event = { id: randomUUID() };
  await db.outboxEvent.create({ data: { id: event.id, type: 'watchlist.updated', schemaVersion: 1, occurredAt: new Date(), audience: 'user', ownerId: u.id, entityType: 'watchlist', entityId: u.id, payload: {}, status: 'DEAD', attempts: 8 } });
  const cred = await issueOperatorCredential(db, { operator: 'ops.cli', scopes: ['ops:read', 'outbox:requeue'], ttlMs: 600000, reason: 'Milestone 30 CLI test' });
  const lines: string[] = [];
  const env = { ...process.env, DATA_MODE: 'mock', DATABASE_URL: url!, PORTFOLIO_ADMIN_TOKEN: cred.token };
  expect(await runAdmin(['requeue-outbox', '--event', event.id, '--reason', 'Redis outage fixed'], env, l => lines.push(l))).toBe(3);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: false, denied: 'confirmation_mismatch' });
  expect(await runAdmin(['requeue-outbox', '--event', event.id, '--confirm', event.id, '--reason', 'Redis outage fixed'], env, l => lines.push(l))).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: true, operator: 'ops.cli', result: { outcome: 'requeued' } });
  expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PENDING');
  expect(await runAdmin(['requeue-outbox', '--event', event.id, '--confirm', event.id, '--reason', 'Second attempt'], env, l => lines.push(l))).toBe(3);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ denied: 'not_dead' });
  expect(await runAdmin(['status'], { ...env, PORTFOLIO_ADMIN_TOKEN: '' }, l => lines.push(l))).toBe(3);
  expect(await runAdmin(['status'], env, l => lines.push(l))).toBe(0);
  expect(JSON.parse(lines.pop()!).result.agentRuns).toBeDefined();
  await db.outboxEvent.delete({ where: { id: event.id } });
 });

 function launch(extra: Record<string, string>) {
  const child = fork(fileURLToPath(new URL('../dist/index.js', import.meta.url)), [], { env: { ...process.env, DATABASE_URL: url!, DATA_MODE: 'mock', AGENT_MODE: 'mock', WORKER_ROLE: 'agent', OPS_REPORT_INTERVAL_MS: '3600000', ...extra }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const output: string[] = [];
  child.stdout!.on('data', b => output.push(String(b))); child.stderr!.on('data', b => output.push(String(b)));
  children.push(child); return { child, output };
 }
 async function waitFor<T>(read: () => Promise<T | null | false>, ms = 20000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const value = await read(); if (value) return value; }
  throw new Error('Timed out');
 }
 it('a draining worker lets a short run finish, claims nothing new, and exits cleanly', async () => {
  const u = await user(), first = await submit(u);
  const { child, output } = launch({ AGENT_MOCK_STREAM_DELAY_MS: '100', WORKER_SHUTDOWN_GRACE_MS: '20000' });
  await waitFor(async () => (await db.agentRun.findUniqueOrThrow({ where: { id: first.run.id } })).executionStartedAt);
  child.send('shutdown');
  const second = await submit(u);
  const [code] = await once(child, 'exit') as [number | null];
  expect(code).toBe(0);
  expect((await u.chat.getRun(first.run.id)).status).toBe('completed');
  expect((await u.chat.getRun(second.run.id)).status).toBe('queued');
  expect(output.join('')).toContain('worker.drained');
  await u.chat.requestCancel(second.run.id);
 }, 40000);
 it('a run still active at the drain deadline is recorded as interrupted before exit, never completed', async () => {
  const u = await user(), run = await submit(u);
  // 1 s between streamed chunks, but the run is aborted ~667 ms after draining starts (1 s grace).
  const { child } = launch({ AGENT_MOCK_STREAM_DELAY_MS: '1000', WORKER_SHUTDOWN_GRACE_MS: '1000' });
  await waitFor(async () => (await db.agentRun.findUniqueOrThrow({ where: { id: run.run.id } })).executionStartedAt);
  const started = Date.now();
  child.send('shutdown');
  const [code] = await once(child, 'exit') as [number | null];
  expect(Date.now() - started).toBeLessThan(2500);
  expect(code).toBe(0);
  // Persisted by the draining worker itself, not by a later lease expiry.
  const row = await db.agentRun.findUniqueOrThrow({ where: { id: run.run.id } });
  expect(row).toMatchObject({ status: 'failed', failureCode: 'interrupted', leaseOwner: null });
  const message = await db.chatMessage.findUniqueOrThrow({ where: { id: row.assistantMessageId } });
  expect(message.status).toBe('failed'); expect(message.content).toContain('interrupted');
  expect(await db.outboxEvent.count({ where: { entityId: run.run.id, type: 'agent.run.completed' } })).toBe(1);
 }, 40000);
});
