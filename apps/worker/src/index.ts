import { runAgentWorker } from './agent.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseServerConfig } from '@portfolio-pilot/config/server';
import { closeConnections, getDatabase, getRedis, ingestionRepository, outboxRepository, publishEvent, redisKeys } from '@portfolio-pilot/db';
import { selectProviders } from '@portfolio-pilot/providers';
import { AlpacaQuoteProvider, AlpacaNewsProvider } from '@portfolio-pilot/providers/server';
import { ingestOnce } from './ingestion.js';
import { dispatchOnce } from './outbox.js';
import { processResearchNews } from '@portfolio-pilot/db';
import { analyzeArticle, ARTICLE_ANALYSIS_PROMPT_VERSION, ClaudeArticleAnalyzer, MockArticleAnalyzer } from '@portfolio-pilot/agent';
import { ARTICLE_ANALYSIS_SCHEMA_VERSION } from '@portfolio-pilot/contracts';
import { drainSchedule, startHealthServer, WorkerLifecycle } from './lifecycle.js';
import { initTelemetry, inSpan, metric } from '@portfolio-pilot/observability';
import { workerLog } from './telemetry.js';

const config = parseServerConfig(process.env);
const role = process.env.WORKER_ROLE || 'ingestion';
if (!['ingestion', 'outbox', 'agent'].includes(role)) throw new Error('Invalid WORKER_ROLE');
const telemetry = initTelemetry({ serviceName: `portfolio-pilot-worker-${role}` });
const log = workerLog();
const lifecycle = new WorkerLifecycle(role, config.WORKER_SHUTDOWN_GRACE_MS);
const abort = { signal: lifecycle.signal };
/**
 * SIGTERM (Kubernetes), SIGINT (terminal) or an IPC 'shutdown' message (Windows supervisors cannot
 * deliver SIGTERM): stop claiming new work, let active work drain until the deadline, then exit even
 * if a dependency hangs. Ingestion and outbox passes finish their current bounded batch; anything
 * left leased expires and is reconciled by another replica.
 */
function shutdown() {
  if (!lifecycle.beginDrain()) return;
  const schedule = drainSchedule(config.WORKER_SHUTDOWN_GRACE_MS);
  log.info('worker.draining', { role, active: lifecycle.active, ...schedule });
  setTimeout(() => { log.error('worker.forced_exit', { role, active: lifecycle.active }); process.exit(1); }, schedule.exitAfterMs).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('message', (message: unknown) => { if (message === 'shutdown') shutdown(); });
// A supervisor that disappears (its IPC channel closes) must not leave an orphaned replica running.
process.on('disconnect', shutdown);
const pause = (ms: number) => sleep(ms, undefined, { signal: abort.signal }).catch(() => undefined);
async function run() {
  console.log(`PortfolioPilot worker role: ${role}; data mode: ${config.DATA_MODE}`);
  log.info('worker.started', { role, dataMode: config.DATA_MODE, traces: telemetry.traces.join(',') || 'none', metrics: telemetry.metrics.join(',') || 'none' });
  // Readiness reports draining as soon as shutdown begins; the listener never keeps the process alive.
  if (config.WORKER_HEALTH_PORT) (await startHealthServer(lifecycle, config.WORKER_HEALTH_PORT, config.WORKER_HEALTH_HOST)).unref();
  if (role === 'outbox') return runOutbox();
  if (role === 'agent') return runAgentWorker(lifecycle);
  if (!config.DATABASE_URL) throw new Error('Ingestion requires DATABASE_URL');
  const repository = ingestionRepository(await getDatabase(config.DATABASE_URL));
  const key = config.DATA_MODE === 'mock' ? `mock:${config.MOCK_SCENARIO}:${config.MOCK_NEWS_INTERVAL_MS}` : 'alpaca-v1';
  const state = await repository.initialize(key, config.MOCK_START_AT ? new Date(config.MOCK_START_AT) : undefined);
  const liveOptions = { key: config.ALPACA_API_KEY ?? '', secret: config.ALPACA_API_SECRET ?? '', rightsConfirmed: config.ALPACA_STORAGE_DISPLAY_RIGHTS_CONFIRMED, timeoutMs: config.PROVIDER_TIMEOUT_MS };
  const live = config.DATA_MODE === 'live' ? { quotes: new AlpacaQuoteProvider(liveOptions), news: new AlpacaNewsProvider(liveOptions) } : undefined;
  const providers = selectProviders(config.DATA_MODE, { startAt: state.mockStartAt.toISOString(), intervalMs: config.MOCK_NEWS_INTERVAL_MS, scenario: config.MOCK_SCENARIO }, live);
  const owner = randomUUID();
  while (!abort.signal.aborted) {
    try {
      // A lease is held only for one acquire -> commit/fail pass, never across the idle sleep.
      const lease = await repository.acquire(key, owner);
      if (lease) {
        // One root span per pass; each changed article then starts its own linked trace.
        const outcome = await inSpan('ingestion.pass', { 'pp.job.id': key, 'pp.job.attempt': lease.generation }, () => ingestOnce(repository, lease, providers, config.INGESTION_INTERVAL_MS), { parent: null });
        if (outcome === 'retry') metric.error('ingestion', 'provider_or_commit');
        log.info('ingestion.pass', { jobId: key, outcome });
      }
    } catch (error) { metric.error('ingestion', 'database_unavailable'); log.error('ingestion.unavailable', { note: 'retrying' }, error); }
    if (process.env.WORKER_ONCE === 'true') break;
    await pause(1000);
  }
}
async function runOutbox() {
  if (!config.DATABASE_URL || !config.REDIS_URL) throw new Error('Outbox dispatch requires DATABASE_URL and REDIS_URL');
  const db = await getDatabase(config.DATABASE_URL);
  const repository = outboxRepository(db);
  const analyzer = config.AGENT_MODE === 'mock' ? new MockArticleAnalyzer() : new ClaudeArticleAnalyzer({ apiKey: config.ANTHROPIC_API_KEY, modelId: config.AGENT_MODEL_ID!, workspaceDir: config.AGENT_WORKSPACE_DIR! });
  const binding = { mode: analyzer.mode, modelKey: analyzer.modelKey, promptVersion: ARTICLE_ANALYSIS_PROMPT_VERSION, schemaVersion: ARTICLE_ANALYSIS_SCHEMA_VERSION,
    run: (input: Parameters<typeof analyzeArticle>[1], signal?: AbortSignal) => analyzeArticle(analyzer, input, signal) };
  const keys = redisKeys();
  const options = { owner: randomUUID(), batchSize: config.OUTBOX_BATCH_SIZE, leaseMs: config.OUTBOX_LEASE_MS, maxAttempts: config.OUTBOX_MAX_ATTEMPTS, processNews: (id: string) => processResearchNews(db, id, binding) };
  let nextPurge = 0;
  while (!abort.signal.aborted) {
    let full = false;
    try {
      // getRedis reconnects lazily, so a Redis outage only delays delivery; events stay PENDING in PostgreSQL.
      const publish = async (event: Parameters<typeof publishEvent>[2]) => publishEvent(await getRedis(config.REDIS_URL!), keys, event);
      const result = await dispatchOnce(repository, publish, options);
      if (result.claimed) log.info('outbox.pass', { ...result });
      full = result.claimed === options.batchSize;
      if (Date.now() >= nextPurge) { await repository.purgePublished(); nextPurge = Date.now() + 600000; }
    } catch (error) { metric.error('outbox', 'database_unavailable'); log.error('outbox.unavailable', { note: 'retrying' }, error); }
    if (process.env.WORKER_ONCE === 'true') break;
    if (!full) await pause(config.OUTBOX_POLL_MS);
  }
}
try { await run(); if (lifecycle.draining) log.info('worker.drained', { role }); }
catch { if (!abort.signal.aborted) { console.error('Worker configuration or startup failed'); process.exitCode = 1; } }
finally { await closeConnections().catch(() => undefined); await telemetry.shutdown(); if (process.connected) process.disconnect(); }
