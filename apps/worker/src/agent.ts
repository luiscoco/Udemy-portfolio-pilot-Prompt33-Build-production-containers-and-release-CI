import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { agentJobs, AGENT_JOB_POLICY, appendRunProgress, chatService, approvalService, agentToolReads, createCache, getDatabase, getRedis, operationsSnapshot, type RunFence } from '@portfolio-pilot/db';
import { parseServerConfig } from '@portfolio-pilot/config/server';
import { executeRun } from './agent-execution.js';
import { RunEventPublisher } from './agent-run-events.js';
import { artifactAgentFactory, configuredArtifactStore } from './agent-artifacts.js';
import { stuckPolicy, type WorkerLifecycle } from './lifecycle.js';
import { actorRef, annotate, inSpan, metric } from '@portfolio-pilot/observability';
import { workerLog } from './telemetry.js';

const quietSleep = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => undefined);

/**
 * Agent role: `AGENT_WORKER_CONCURRENCY` claim loops share one process; `AGENT_GLOBAL_CONCURRENCY`
 * caps live leases across every replica (enforced in the claim transaction). A conversation never
 * runs twice at once: claims lock the conversation row and the database has a unique active-run index.
 */
export async function runAgentWorker(lifecycle: WorkerLifecycle) {
 const config = parseServerConfig(process.env);
 if (!config.DATABASE_URL) throw new Error('Agent worker requires DATABASE_URL');
 const db = await getDatabase(config.DATABASE_URL);
 const jobs = agentJobs(db), processKey = `${config.INSTANCE_ID ?? 'worker'}:${randomUUID()}`;
 const artifacts = configuredArtifactStore(config);
 const cache = createCache({ redis: async () => config.REDIS_URL ? getRedis(config.REDIS_URL) : null });
 const once = process.env.WORKER_ONCE === 'true';

 async function execute(fence: RunFence) {
  const stop = new AbortController();
  // Draining does not abort running work immediately; only the drain deadline does.
  const disposeDeadline = lifecycle.onDrainDeadline(() => stop.abort('worker_shutdown'));
  const timer = setTimeout(() => stop.abort('timeout'), config.AGENT_WALL_CLOCK_MS);
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  const pulse = async () => {
   try { if (await jobs.heartbeat(fence) === 'cancelled') stop.abort('cancelled'); }
   catch { stop.abort('lease_lost'); }
   if (!stop.signal.aborted) heartbeat = setTimeout(() => { void pulse(); }, AGENT_JOB_POLICY.heartbeatMs);
  };
  lifecycle.active++;
  // The durable job row IS the run: continue the submitting request's trace from its stored context.
  const job = await db.agentRun.findUnique({ where: { id: fence.runId }, select: { traceparent: true, createdAt: true, kind: true } });
  const claimedAt = Date.now();
  if (job) metric.queueAge((claimedAt - job.createdAt.getTime()) / 1000, { queue: 'agent_job', event_type: job.kind });
  const log = workerLog();
  try {
   await inSpan('agent.run', { 'pp.run.id': fence.runId, 'pp.job.id': fence.runId, 'pp.job.attempt': fence.attempt, 'pp.kind': job?.kind ?? 'other' }, async span => {
   if (await jobs.heartbeat(fence, true) === 'cancelled') stop.abort('cancelled');
   const owner = await jobs.owner(fence), chat = chatService(db, owner, fence);
   const run = await chat.getRun(fence.runId), conversation = await chat.get(run.conversationId);
   const user = await db.chatMessage.findUniqueOrThrow({ where: { id: run.userMessageId } });
   const userMessage = (await chat.messages(run.conversationId, { limit: 50 })).messages.find(m => m.id === user.id)!;
   const publisher = new RunEventPublisher(async event => { try { await appendRunProgress(db, fence, event); } catch (error) { stop.abort('progress_failure'); throw error; } }, { ownerId: owner.userId, runId: run.id, conversationId: conversation.id, messageId: run.assistantMessageId });
   const actor = actorRef(owner.userId);
   annotate({ 'pp.actor': actor }, span);
   log.info('agent.run.started', { runId: run.id, jobId: run.id, attempt: fence.attempt, actor, kind: run.kind });
   void pulse();
   const summary = await executeRun({ ownerId: owner.userId, chat, approvals: approvalService(db, owner, () => new Date(), fence),
    agentFactory: artifactAgentFactory(artifacts, { ownerId: owner.userId, conversationId: conversation.id }, config),
    tools: { data: agentToolReads(db, cache, owner), dataMode: config.DATA_MODE }, run, conversation, userMessage, publisher, signal: stop.signal });
   const seconds = (Date.now() - claimedAt) / 1000;
   const mode = summary.mode ?? (config.AGENT_MODE === 'mock' ? 'mock' : 'claude');
   annotate({ 'pp.outcome': summary.status, 'pp.failure_code': summary.failureCode ?? 'none', 'pp.mode': mode, 'pp.usage.tokens': summary.usage?.aggregateTokens ?? 0,
    'pp.usage.cost_usd': Number(summary.usage?.estimatedCostUsd ?? 0), 'pp.usage.accounting': summary.usage?.accounting ?? 'not_started' }, span);
   if (summary.status === 'failed') span.setStatus({ code: 2 });
   metric.runDuration(seconds, { kind: run.kind, outcome: summary.status, mode });
   if (summary.usage) metric.usage(summary.usage.aggregateTokens, Number(summary.usage.estimatedCostUsd), { mode, accounting: summary.usage.accounting });
   if (summary.failureCode) metric.error('agent_worker', summary.failureCode);
   log.info('agent.run.finished', { runId: run.id, jobId: run.id, attempt: fence.attempt, actor, outcome: summary.status, code: summary.failureCode ?? undefined,
    durationMs: Math.round(seconds * 1000), aggregateUsage: summary.usage?.aggregateTokens ?? 0, accounting: summary.usage?.accounting ?? 'not_started', announced: summary.announced });
   }, { parent: job?.traceparent ?? null, kind: 'consumer' });
  } finally { lifecycle.active--; disposeDeadline(); clearTimeout(timer); clearTimeout(heartbeat); stop.abort('settled'); }
 }

 async function slot(index: number) {
  const ownerKey = `${processKey}:${index}`;
  while (!lifecycle.signal.aborted) {
   let fence: RunFence | null = null;
   try {
    fence = await jobs.claim(ownerKey, { globalConcurrency: config.AGENT_GLOBAL_CONCURRENCY });
    if (fence && lifecycle.draining) {
     // Shutdown arrived between claim and start: hand the untouched job to another replica.
     const released = await jobs.release(fence);
     workerLog().info('agent.job.released', { runId: fence.runId, jobId: fence.runId, released });
     if (released === 'released') { fence = null; break; }
    }
    if (fence) await execute(fence);
   } catch (error) { metric.error('agent_worker', 'job_interrupted'); workerLog().error('agent.job.interrupted', { runId: fence?.runId, note: 'Durable recovery will reconcile its lease.' }, error); }
   if (once) break;
   // A worker that just finished a job polls again immediately; an idle one waits.
   if (!fence) await quietSleep(AGENT_JOB_POLICY.pollMs, lifecycle.signal);
  }
 }

 /** Lease recovery, artifact retention, queue-depth and stuck-job reporting for this replica. */
 async function maintenance() {
  let pruneAt = 0, reportAt = 0;
  while (!lifecycle.signal.aborted) {
   try {
    if (Date.now() >= pruneAt) { await artifacts.prune(); pruneAt = Date.now() + 3600000; }
    const recovered = await jobs.recover();
    if (recovered) workerLog().info('agent.jobs.recovered', { count: recovered });
    if (Date.now() >= reportAt) {
     reportAt = Date.now() + config.OPS_REPORT_INTERVAL_MS;
     const snapshot = await operationsSnapshot(db, stuckPolicy(config));
     // Aggregates only: no owner, prompt or answer text is logged.
     workerLog().info('operations.snapshot', { instance: config.INSTANCE_ID ?? null, agentRuns: snapshot.agentRuns, outbox: snapshot.outbox,
      stuck: snapshot.stuck.length, globalConcurrency: config.AGENT_GLOBAL_CONCURRENCY, active: lifecycle.active });
     if (snapshot.stuck.length) workerLog().warn('operations.stuck', { runs: snapshot.stuck.slice(0, 20) });
    }
   } catch (error) { metric.error('agent_worker', 'maintenance_unavailable'); workerLog().error('agent.maintenance.unavailable', { note: 'retrying' }, error); }
   if (once) break;
   await quietSleep(1000, lifecycle.signal);
  }
 }
 if (once) { await maintenance(); await slot(0); return; }
 await Promise.all([maintenance(), ...Array.from({ length: config.AGENT_WORKER_CONCURRENCY }, (_, index) => slot(index))]);
}
