// Milestone 30 distributed acceptance. Runs two managed API replicas and two agent workers (plus two
// outbox dispatchers) behind the local reverse proxy against a DEDICATED PostgreSQL and Redis pair,
// then injects failures by terminating processes and stopping the dependency containers.
//
// Required (refuses anything that is not a dedicated loopback verification environment):
//   DISTRIBUTED_TEST_DATABASE_URL  postgresql://...@127.0.0.1:<port>/portfolio_m30_verify (migrated)
//   DISTRIBUTED_TEST_REDIS_URL     redis://127.0.0.1:<port>   (a Redis this script may stop and flush)
//   DISTRIBUTED_PG_CONTAINER / DISTRIBUTED_REDIS_CONTAINER   Docker containers backing those URLs
// Prerequisite: `npm run build` (API .next output, web dist and worker dist).
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { closeConnections, getDatabase } from '../packages/db/dist/index.js';
import { seedDemo } from '../packages/db/dist/seed.js';
import { createLocalProxy } from './local-proxy.mjs';

const databaseUrl = process.env.DISTRIBUTED_TEST_DATABASE_URL, redisUrl = process.env.DISTRIBUTED_TEST_REDIS_URL;
const pgContainer = process.env.DISTRIBUTED_PG_CONTAINER, redisContainer = process.env.DISTRIBUTED_REDIS_CONTAINER;
assert.ok(databaseUrl && redisUrl && pgContainer && redisContainer, 'Set DISTRIBUTED_TEST_DATABASE_URL, DISTRIBUTED_TEST_REDIS_URL, DISTRIBUTED_PG_CONTAINER and DISTRIBUTED_REDIS_CONTAINER.');
const pg = new URL(databaseUrl), rd = new URL(redisUrl);
assert.equal(pg.hostname, '127.0.0.1'); assert.equal(pg.pathname, '/portfolio_m30_verify'); assert.equal(rd.hostname, '127.0.0.1');

const root = fileURLToPath(new URL('..', import.meta.url));
const PROXY_PORT = 5320, API_PORTS = { 'api-a': 5321, 'api-b': 5322 };
const origin = `http://127.0.0.1:${PROXY_PORT}`;
const AUTH_SECRET = 'milestone-30-distributed-verification-only-secret';
const common = { NODE_ENV: 'development', DATA_MODE: 'mock', AGENT_MODE: 'mock', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, DEMO_AUTH_ENABLED: 'true',
  AUTH_BASE_URL: origin, AUTH_SECRET, AGENT_DAILY_BUDGET_USD: '1000', AGENT_MAX_ACTIVE_RUNS_PER_USER: '4', AGENT_GLOBAL_CONCURRENCY: '3', AGENT_WORKER_CONCURRENCY: '2',
  AGENT_SUBMIT_RATE_LIMIT_PER_MINUTE: '40', API_RATE_LIMIT_PER_MINUTE: '5000', AGENT_MOCK_STREAM_DELAY_MS: '150', OUTBOX_POLL_MS: '100', API_SHUTDOWN_GRACE_MS: '8000',
  WORKER_SHUTDOWN_GRACE_MS: '8000', OPS_REPORT_INTERVAL_MS: '5000', SESSION_ARTIFACT_DIR: mkdtempSync(join(tmpdir(), 'pp-m30-artifacts-')) };
const results = [];
const processes = new Map();
const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args);
let db = await getDatabase(databaseUrl);

// ---------------------------------------------------------------- process control
function start(name, script, extra = {}, cwd = root) {
  const child = fork(script, [], { cwd, env: { ...process.env, ...common, INSTANCE_ID: name, ...extra }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const output = [];
  child.stdout.on('data', b => output.push(String(b))); child.stderr.on('data', b => output.push(String(b)));
  const entry = { name, child, output, exited: once(child, 'exit') };
  processes.set(name, entry);
  return entry;
}
async function startApi(name) {
  const entry = start(name, join(root, 'apps/api/server.mjs'), { PORT: String(API_PORTS[name]) }, join(root, 'apps/api'));
  await waitFor(`${name} listening`, async () => (await fetch(`http://127.0.0.1:${API_PORTS[name]}/api/health/live`).catch(() => null))?.ok, 60000);
  return entry;
}
const startWorker = (name, extra = {}) => start(name, join(root, 'apps/worker/dist/index.js'), { WORKER_ROLE: 'agent', ...extra });
const startOutbox = name => start(name, join(root, 'apps/worker/dist/index.js'), { WORKER_ROLE: 'outbox' });
async function graceful(name, ms = 12000) {
  const entry = processes.get(name); entry.child.send('shutdown');
  const [code] = await Promise.race([entry.exited, sleep(ms).then(() => ['timeout'])]);
  processes.delete(name); return code;
}
async function kill(name) { const entry = processes.get(name); entry.child.kill(); await entry.exited; processes.delete(name); }
function docker(...args) { const r = spawnSync('docker', args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`); return r.stdout.trim(); }
async function waitFor(label, check, ms = 30000, every = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) { try { const value = await check(); if (value) return value; } catch { /* retry */ } }
  throw new Error(`Timed out waiting for ${label}`);
}
async function scenario(name, run) {
  const started = Date.now();
  log(`== ${name}`);
  try { const detail = await run(); results.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) }); log(`   PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack ?? String(error) }); log(`   FAIL ${name}: ${error.message}`); throw error; }
}

// ---------------------------------------------------------------- HTTP helpers
async function call(base, cookie, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: { cookie, origin, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let json = null; try { json = await response.json(); } catch { /* empty */ }
  return { status: response.status, json, headers: response.headers };
}
async function signIn(account) {
  const response = await fetch(`${origin}/api/auth/demo-sign-in`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ account }) });
  assert.equal(response.status, 200, `sign-in ${account}`);
  return response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
}
const apiBase = name => `http://127.0.0.1:${API_PORTS[name]}`;
async function conversation(base, cookie) { const r = await call(base, cookie, '/api/conversations', { method: 'POST', body: { title: 'Milestone 30' } }); assert.equal(r.status, 201); return r.json.conversation.id; }
async function submit(base, cookie, conversationId, content = 'Explain my holdings') { return call(base, cookie, `/api/conversations/${conversationId}/runs`, { method: 'POST', body: { content } }); }
async function settled(runId, ms = 30000) {
  return waitFor(`run ${runId} terminal`, async () => { const row = await db.agentRun.findUnique({ where: { id: runId } }); return row && !['queued', 'running', 'waiting_for_approval'].includes(row.status) ? row : null; }, ms);
}

// ---------------------------------------------------------------- minimal EventSource with Last-Event-ID resume
class Stream {
  constructor(name, base, cookie) { Object.assign(this, { name, base, cookie, events: [], resets: [], raw: '', connections: 0, stopped: false, lastId: null }); }
  async recover() {
    const snapshot = await call(this.base, this.cookie, '/api/events/recovery');
    if (snapshot.status !== 200 || !snapshot.json.cursor) return false;
    this.lastId = snapshot.json.cursor; return true;
  }
  start() { this.loop = this.run(); return this; }
  async run() {
    while (!this.stopped) {
      try {
        if (!this.lastId && !await this.recover()) { await sleep(500); continue; }
        this.controller = new AbortController();
        const response = await fetch(this.base + '/api/events', { headers: { cookie: this.cookie, 'last-event-id': this.lastId }, signal: this.controller.signal });
        if (response.status !== 200) { await response.body?.cancel(); await sleep(500); continue; }
        this.connections++;
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) { this.frame(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
        }
      } catch { /* connection lost: resume from lastId */ }
      if (!this.stopped) await sleep(250);
    }
  }
  frame(text) {
    this.raw += text + '\n\n';
    let id = null, type = null, data = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (type === 'stream.reset') { this.resets.push(JSON.parse(data).reason); this.lastId = null; return; }
    if (id) this.lastId = id;
    if (type) this.events.push({ type, ...JSON.parse(data) });
  }
  runEvents(runId) { return this.events.filter(e => e.runId === runId || e.payload?.runId === runId || e.entityId === runId); }
  completed(runId) { return this.events.find(e => e.type === 'agent.run.completed' && (e.runId === runId)); }
  async stop() { this.stopped = true; this.controller?.abort(); await this.loop?.catch(() => undefined); }
}

// Leases observed while sampling the database: proves both workers executed and the caps held.
const sampling = { maxLive: 0, owners: new Set(), perConversation: 0, stop: false };
async function sampler() {
  while (!sampling.stop) {
    try {
      const rows = await db.agentRun.findMany({ where: { status: { in: ['running', 'waiting_for_approval'] }, leaseUntil: { gt: new Date() } }, select: { leaseOwner: true, conversationId: true } });
      sampling.maxLive = Math.max(sampling.maxLive, rows.length);
      for (const row of rows) if (row.leaseOwner) sampling.owners.add(row.leaseOwner.split(':')[0]);
      const counts = rows.reduce((m, r) => m.set(r.conversationId, (m.get(r.conversationId) ?? 0) + 1), new Map());
      sampling.perConversation = Math.max(sampling.perConversation, ...counts.values(), 0);
    } catch { /* database outage scenario */ }
    await sleep(50);
  }
}

const proxy = createLocalProxy({ upstreams: Object.values(API_PORTS).map(p => `http://127.0.0.1:${p}`), staticDir: join(root, 'apps/web/dist'), healthIntervalMs: 250 });
const streams = [];
const keys = [];
let alice, bob;
try {
  // ---------------------------------------------------------------- setup
  await seedDemo(db);
  await db.conversation.deleteMany({ where: { ownerId: { in: ['demo-alice', 'demo-bob'] } } });
  await db.dailyAgentBudget.deleteMany({ where: { ownerId: { in: ['demo-alice', 'demo-bob'] } } });
  await db.portfolioTransaction.deleteMany({ where: { idempotencyKey: { startsWith: 'm30-' } } });
  docker('exec', redisContainer, 'redis-cli', 'FLUSHALL');
  await Promise.all([startApi('api-a'), startApi('api-b')]);
  startWorker('worker-1'); startWorker('worker-2'); startOutbox('outbox-1'); startOutbox('outbox-2');
  proxy.server.listen(PROXY_PORT, '127.0.0.1'); await once(proxy.server, 'listening'); await proxy.probes();
  void sampler();
  alice = await signIn('alice'); bob = await signIn('bob');
  const portfolio = (await call(origin, alice, '/api/portfolios')).json.portfolios[0].id;
  const trade = (key, base = origin) => { keys.push(key); return call(base, alice, `/api/portfolios/${portfolio}/transactions`, { method: 'POST', headers: { 'Idempotency-Key': key },
    body: { security: { symbol: 'ACME', exchangeMic: 'XNAS', currency: 'USD' }, side: 'BUY', quantity: '1', price: '10.00', fees: '0', occurredAt: '2025-01-10T15:00:00.000Z' } }); };

  await scenario('two API replicas and two agent workers behind one origin', async () => {
    assert.equal((await call(origin, alice, '/api/health/ready')).json.status, 'ready');
    for (let i = 0; i < 10; i++) assert.equal((await call(origin, alice, '/api/me')).status, 200);
    const routed = Object.fromEntries(proxy.stats.routed);
    assert.ok(Object.values(routed).every(n => n >= 3), `both replicas served traffic: ${JSON.stringify(routed)}`);
    assert.equal((await fetch(`${origin}/assistant`)).headers.get('content-type'), 'text/html; charset=utf-8');
    return { routed };
  });

  const aliceOnB = new Stream('alice@api-b', apiBase('api-b'), null), bobOnA = new Stream('bob@api-a', apiBase('api-a'), null);
  await scenario('events reach users on either replica, and never another user', async () => {
    aliceOnB.cookie = alice; bobOnA.cookie = bob; streams.push(aliceOnB.start(), bobOnA.start());
    await waitFor('streams connected', () => aliceOnB.connections && bobOnA.connections);
    // Alice submits through replica A while her stream is held by replica B, and vice versa for Bob.
    const aliceRun = (await submit(apiBase('api-a'), alice, await conversation(apiBase('api-a'), alice))).json.run;
    const bobRun = (await submit(apiBase('api-b'), bob, await conversation(apiBase('api-b'), bob))).json.run;
    await Promise.all([settled(aliceRun.id), settled(bobRun.id)]);
    await waitFor('alice completion on B', () => aliceOnB.completed(aliceRun.id));
    await waitFor('bob completion on A', () => bobOnA.completed(bobRun.id));
    const sequences = aliceOnB.runEvents(aliceRun.id).map(e => e.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.ok(!aliceOnB.raw.includes(bobRun.id) && !aliceOnB.raw.includes(bobRun.conversationId));
    assert.ok(!bobOnA.raw.includes(aliceRun.id) && !bobOnA.raw.includes(aliceRun.conversationId));
    return { aliceEvents: aliceOnB.runEvents(aliceRun.id).length, bobEvents: bobOnA.runEvents(bobRun.id).length };
  });

  await scenario('one conversation never executes concurrently; caps hold across replicas', async () => {
    const shared = await conversation(origin, alice);
    const duplicate = await Promise.all([submit(apiBase('api-a'), alice, shared), submit(apiBase('api-b'), alice, shared)]);
    assert.deepEqual(duplicate.map(r => r.status).sort(), [202, 409]);
    const first = duplicate.find(r => r.status === 202).json.run;
    const runs = [first];
    const conversations = { [shared]: [first.id] };
    for (const [user, count] of [[alice, 2], [bob, 3]]) for (let i = 0; i < count; i++) {
      const id = await conversation(origin, user);
      const r = await submit(i % 2 ? apiBase('api-a') : apiBase('api-b'), user, id);
      assert.equal(r.status, 202); runs.push(r.json.run); conversations[id] = [r.json.run.id];
    }
    await Promise.all(runs.map(r => settled(r.id)));
    // Follow-ups in the same conversations, through the other replica.
    const follow = [];
    for (const r of runs) {
      const cookie = (await db.conversation.findUnique({ where: { id: r.conversationId } })).ownerId === 'demo-alice' ? alice : bob;
      const f = await submit(apiBase('api-b'), cookie, r.conversationId, 'Tell me more'); assert.equal(f.status, 202); follow.push(f.json.run); conversations[r.conversationId].push(f.json.run.id);
    }
    await Promise.all(follow.map(r => settled(r.id)));
    for (const ids of Object.values(conversations)) {
      const rows = await db.agentRun.findMany({ where: { id: { in: ids } }, orderBy: { executionStartedAt: 'asc' } });
      for (let i = 1; i < rows.length; i++) assert.ok(rows[i].executionStartedAt >= rows[i - 1].completedAt, 'turns of one conversation never overlap');
    }
    assert.ok(sampling.perConversation <= 1);
    assert.ok(sampling.maxLive <= 3, `global concurrency ${sampling.maxLive} <= 3`);
    assert.ok(sampling.owners.has('worker-1') && sampling.owners.has('worker-2'), `both workers executed: ${[...sampling.owners]}`);
    // Per-user active cap (4) is enforced across replicas in the admission transaction.
    const capped = await Promise.all(Array.from({ length: 5 }, async (_, i) => submit(i % 2 ? apiBase('api-a') : apiBase('api-b'), alice, await conversation(origin, alice))));
    assert.deepEqual(capped.map(r => r.status).sort(), [202, 202, 202, 202, 429]);
    assert.equal(capped.find(r => r.status === 429).json.error.code, 'RATE_LIMITED');
    await Promise.all(capped.filter(r => r.status === 202).map(r => settled(r.json.run.id)));
    // The same idempotent trade sent to both replicas at once records one transaction.
    const same = await Promise.all([trade('m30-concurrent-1', apiBase('api-a')), trade('m30-concurrent-1', apiBase('api-b'))]);
    assert.ok(same.every(r => r.status === 200), JSON.stringify(same.map(r => r.status)));
    assert.deepEqual(same.map(r => r.json.replayed).sort(), [false, true]);
    assert.equal(same[0].json.transaction.id, same[1].json.transaction.id);
    return { maxLiveLeases: sampling.maxLive, workers: [...sampling.owners], runs: runs.length + follow.length };
  });

  const viaProxy = [new Stream('alice@proxy-1', origin, alice), new Stream('alice@proxy-2', origin, alice)];
  await scenario('hard API termination: streams resume on the surviving replica without gaps', async () => {
    streams.push(...viaProxy.map(s => s.start()));
    await waitFor('proxy streams connected', () => viaProxy.every(s => s.connections));
    await kill('api-a');
    const run = (await submit(origin, alice, await conversation(origin, alice))).json.run;
    await settled(run.id);
    for (const s of viaProxy) {
      await waitFor(`${s.name} completion`, () => s.completed(run.id));
      const seq = [...new Set(s.runEvents(run.id).map(e => e.sequence))].sort((a, b) => a - b);
      assert.deepEqual(seq, seq.map((_, i) => i), `${s.name} received every sequence`);
    }
    await startApi('api-a');
    await waitFor('api-a back in rotation', () => proxy.state.every(s => s.ready));
    return { reconnections: viaProxy.map(s => s.connections) };
  });

  await scenario('graceful API drain: readiness drops, nothing is lost or duplicated, exit within the deadline', async () => {
    const run = (await submit(origin, alice, await conversation(origin, alice))).json.run;
    const entry = processes.get('api-b'), before = viaProxy.map(s => s.connections);
    entry.child.send('shutdown');
    const during = await Promise.all(Array.from({ length: 20 }, () => call(origin, alice, '/api/portfolios')));
    assert.ok(during.every(r => r.status === 200), `requests during drain: ${during.map(r => r.status)}`);
    const t = await trade('m30-drain-1'); assert.equal(t.status, 200); assert.equal(t.json.replayed, false);
    const [code] = await Promise.race([entry.exited, sleep(12000).then(() => ['timeout'])]);
    assert.equal(code, 0); processes.delete('api-b');
    assert.ok(entry.output.join('').includes('api.drained'));
    await settled(run.id);
    for (const s of viaProxy) await waitFor(`${s.name} completion after drain`, () => s.completed(run.id));
    assert.equal((await trade('m30-drain-1')).json.transaction.id, t.json.transaction.id);
    await startApi('api-b'); await waitFor('api-b back', () => proxy.state.every(s => s.ready));
    return { proxyRetries: proxy.stats.retries, reconnectsBefore: before, reconnectsAfter: viaProxy.map(s => s.connections) };
  });

  await scenario('worker termination: graceful drain completes work; a killed worker leaves a truthful interruption', async () => {
    const drained = (await submit(origin, alice, await conversation(origin, alice))).json.run;
    await waitFor('drained run started', async () => (await db.agentRun.findUnique({ where: { id: drained.id } })).executionStartedAt);
    const owner = (await db.agentRun.findUnique({ where: { id: drained.id } })).leaseOwner.split(':')[0];
    assert.equal(await graceful(owner), 0);
    assert.equal((await settled(drained.id)).status, 'completed');
    startWorker(owner);
    // Replace both workers with one slow worker, then kill it mid-run.
    assert.equal(await graceful('worker-1'), 0); assert.equal(await graceful('worker-2'), 0);
    startWorker('worker-slow', { AGENT_MOCK_STREAM_DELAY_MS: '1000' });
    const killed = (await submit(origin, alice, await conversation(origin, alice))).json.run;
    await waitFor('slow run streaming', async () => (await db.agentRunChunk.count({ where: { runId: killed.id } })) > 0);
    await kill('worker-slow');
    startWorker('worker-1'); startWorker('worker-2');
    // No fast-forward: the real 30 s lease must expire before another worker reconciles it.
    const row = await settled(killed.id, 60000);
    assert.equal(row.status, 'failed'); assert.equal(row.failureCode, 'interrupted'); assert.equal(row.attempt, 1);
    const message = await db.chatMessage.findUnique({ where: { id: row.assistantMessageId } });
    assert.equal(message.status, 'failed'); assert.match(message.content, /interrupted/);
    await waitFor('interruption announced', () => viaProxy[0].completed(killed.id));
    assert.equal(viaProxy[0].completed(killed.id).status, 'failed');
    return { drainedBy: owner, interruptedAfterMs: row.completedAt - row.executionStartedAt };
  });

  await scenario('Redis outage: live streaming degrades, PostgreSQL stays authoritative, delivery resumes', async () => {
    docker('stop', redisContainer);
    await waitFor('readiness degraded', async () => (await call(origin, alice, '/api/health/ready')).json?.dependencies.redis === 'down', 20000);
    const ready = await call(origin, alice, '/api/health/ready');
    assert.equal(ready.status, 200); assert.equal(ready.json.status, 'degraded');
    await waitFor('streams reset as unavailable', () => viaProxy.every(s => s.resets.includes('unavailable')));
    const t = await trade('m30-redis-1'); assert.equal(t.status, 200); assert.equal(t.json.replayed, false);
    const replay = await trade('m30-redis-1'); assert.equal(replay.json.transaction.id, t.json.transaction.id); assert.equal(replay.json.replayed, true);
    const created = await submit(origin, alice, await conversation(origin, alice));
    assert.equal(created.status, 202); assert.equal(created.json.replayCursor, null);
    const row = await settled(created.json.run.id);
    assert.equal(row.status, 'completed');
    assert.equal((await call(origin, alice, `/api/runs/${row.id}`)).json.run.status, 'completed');
    const pending = await db.outboxEvent.count({ where: { entityId: row.id, status: 'PENDING' } });
    assert.ok(pending > 0, 'events wait durably in PostgreSQL');
    docker('start', redisContainer);
    await waitFor('readiness ready', async () => (await call(origin, alice, '/api/health/ready')).json?.status === 'ready', 30000);
    await waitFor('outbox delivered', async () => (await db.outboxEvent.count({ where: { entityId: row.id, status: { not: 'PUBLISHED' } } })) === 0, 30000);
    const after = (await submit(origin, alice, await conversation(origin, alice))).json.run;
    await settled(after.id);
    for (const s of viaProxy) await waitFor(`${s.name} live again`, () => s.completed(after.id), 30000);
    return { pendingDuringOutage: pending };
  });

  await scenario('expired or trimmed retention resets to an authoritative snapshot', async () => {
    const stale = viaProxy[0].lastId;
    const run = (await submit(origin, alice, await conversation(origin, alice))).json.run;
    await settled(run.id); await waitFor('delivered', () => viaProxy[0].completed(run.id));
    docker('exec', redisContainer, 'redis-cli', 'XTRIM', 'pp:v1:events:user:{demo-alice}', 'MAXLEN', '0');
    const next = (await submit(origin, alice, await conversation(origin, alice))).json.run;
    await settled(next.id);
    const trimmed = new Stream('alice@stale', origin, alice); trimmed.lastId = stale; streams.push(trimmed.start());
    await waitFor('trimmed reset', () => trimmed.resets.includes('trimmed'));
    // Expired: a correctly signed cursor older than the 7-day replay window.
    const epoch = docker('exec', redisContainer, 'redis-cli', 'GET', 'pp:v1:events:epoch');
    const old = `v1.${epoch}.${Date.now() - 8 * 24 * 3600000}-0`;
    const body = Buffer.from(JSON.stringify({ user: old, market: old })).toString('base64url');
    const signature = createHmac('sha256', AUTH_SECRET).update(`sse-v1\ndemo-alice\n${body}`).digest('base64url');
    const expired = new Stream('alice@expired', origin, alice); expired.lastId = `s1.${body}.${signature}`; streams.push(expired.start());
    await waitFor('expired reset', () => expired.resets.includes('expired'));
    const messages = (await call(origin, alice, `/api/conversations/${next.conversationId}/messages`)).json.messages;
    assert.ok(messages.some(m => m.id === next.assistantMessageId && m.status === 'completed'), 'snapshot still shows the durable answer');
    await waitFor('stale client recovered live', () => trimmed.connections >= 1 && trimmed.lastId);
    return { resets: { trimmed: trimmed.resets, expired: expired.resets } };
  });

  await scenario('database outage: requests fail honestly, in-flight work is never completed falsely, retries do not duplicate', async () => {
    assert.equal(await graceful('worker-1'), 0); assert.equal(await graceful('worker-2'), 0);
    startWorker('worker-slow-2', { AGENT_MOCK_STREAM_DELAY_MS: '1000' });
    const inflight = (await submit(origin, alice, await conversation(origin, alice))).json.run;
    await waitFor('in-flight run streaming', async () => (await db.agentRunChunk.count({ where: { runId: inflight.id } })) > 0);
    docker('stop', pgContainer);
    await waitFor('readiness reports database down', async () => (await call(origin, alice, '/api/health/ready')).json?.dependencies.postgres === 'down', 20000);
    const ready = await call(origin, alice, '/api/health/ready');
    assert.equal(ready.status, 200); assert.equal(ready.json.status, 'degraded');
    const read = await call(origin, alice, '/api/portfolios');
    assert.equal(read.status, 503); assert.equal(read.json.error.code, 'SERVICE_UNAVAILABLE'); assert.match(read.json.error.message, /Nothing was changed/);
    const write = await trade('m30-db-1'); assert.equal(write.status, 503);
    await sleep(3000);
    for (const [name, entry] of processes) assert.equal(entry.child.exitCode, null, `${name} survived the outage`);
    docker('start', pgContainer);
    await waitFor('database back', async () => (await call(origin, alice, '/api/health/ready')).json?.status === 'ready', 60000, 500);
    await closeConnections(); db = await getDatabase(databaseUrl);
    const retried = await waitFor('trade accepted after recovery', async () => { const r = await trade('m30-db-1'); return r.status === 200 ? r : null; }, 30000, 500);
    assert.equal(retried.json.replayed, false, 'the refused write was never recorded during the outage');
    assert.equal((await trade('m30-db-1')).json.transaction.id, retried.json.transaction.id);
    const row = await settled(inflight.id, 90000);
    assert.notEqual(row.status, 'completed', 'a run cut off by the outage is not reported completed');
    assert.equal(row.status, 'failed');
    await kill('worker-slow-2'); startWorker('worker-1'); startWorker('worker-2');
    return { inflightOutcome: `${row.status}:${row.failureCode}` };
  });

  await scenario('per-user submission rate is shared by both replicas', async () => {
    // Fixed one-minute windows: start near the beginning of one so the burst is not split.
    if (Date.now() % 60000 > 40000) await sleep(60000 - (Date.now() % 60000) + 200);
    const target = await conversation(origin, bob), statuses = [];
    for (let i = 0; i < 50; i++) statuses.push((await submit(i % 2 ? apiBase('api-a') : apiBase('api-b'), bob, target, 'burst')).status);
    const accepted = statuses.findIndex(s => s === 429);
    assert.ok(accepted > 0 && accepted <= 40, `first 429 after ${accepted} submissions (shared limit 40, not 2 x 40)`);
    assert.ok(statuses.slice(accepted).every(s => s === 429), 'both replicas keep refusing in the same window');
    const active = await db.agentRun.findFirst({ where: { conversationId: target, status: { in: ['queued', 'running'] } } });
    if (active) await settled(active.id);
    return { acceptedBeforeLimit: accepted };
  });

  await scenario('acceptance invariants: no duplicate financial mutations, no cross-user events, no false completions', async () => {
    for (const key of new Set(keys)) {
      const count = await db.portfolioTransaction.count({ where: { idempotencyKey: key } });
      assert.equal(count, 1, `exactly one transaction for ${key}`);
    }
    const runs = await db.agentRun.findMany({ where: { conversation: { ownerId: { in: ['demo-alice', 'demo-bob'] } } }, include: { conversation: true } });
    const aliceIds = new Set(runs.filter(r => r.conversation.ownerId === 'demo-alice').flatMap(r => [r.id, r.conversationId, r.assistantMessageId]));
    const bobIds = new Set(runs.filter(r => r.conversation.ownerId === 'demo-bob').flatMap(r => [r.id, r.conversationId, r.assistantMessageId]));
    for (const s of streams) {
      const foreign = s.name.startsWith('alice') ? bobIds : aliceIds;
      for (const id of foreign) assert.ok(!s.raw.includes(id), `${s.name} never received another user's ${id}`);
    }
    for (const run of runs) {
      const messages = await db.chatMessage.findMany({ where: { id: run.assistantMessageId } });
      if (run.status === 'completed') {
        assert.equal(messages.length, 1); assert.equal(messages[0].status, 'completed');
        const finals = await db.agentRunChunk.findMany({ where: { runId: run.id } });
        assert.equal(finals.filter(c => c.event.type === 'agent.run.completed').length, 1);
        assert.equal(finals.find(c => c.event.type === 'agent.run.completed').event.payload.status, 'completed');
      } else assert.ok(messages.length <= 1 && (messages[0]?.status ?? run.status) !== 'completed', `run ${run.id} is not falsely completed`);
    }
    const byStatus = runs.reduce((m, r) => ({ ...m, [`${r.status}${r.failureCode ? ':' + r.failureCode : ''}`]: (m[`${r.status}${r.failureCode ? ':' + r.failureCode : ''}`] ?? 0) + 1 }), {});
    return { transactionKeys: new Set(keys).size, runs: byStatus, streams: streams.map(s => ({ name: s.name, events: s.events.length, resets: s.resets })) };
  });
} finally {
  sampling.stop = true;
  for (const s of streams) await s.stop();
  try { docker('start', redisContainer); docker('start', pgContainer); } catch { /* best effort */ }
  for (const [name] of [...processes]) { try { await graceful(name, 10000); } catch { /* already gone */ } }
  for (const entry of processes.values()) entry.child.kill();
  await new Promise(resolve => proxy.server.close(resolve));
  await closeConnections().catch(() => undefined);
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ summary: { passed: results.length - failed.length, failed: failed.length }, results }, null, 1));
  if (failed.length || results.length < 10) process.exitCode = 1;
}
