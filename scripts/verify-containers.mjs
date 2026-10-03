// Milestone 33 containerized mock smoke test. Builds (unless --skip-build) and starts compose.production.yaml
// under its own project name, then checks the release images as a user and an operator would:
//   - posture: every app container runs non-root, read-only, with no capabilities; app code is not
//     writable, while the SDK workspace is; demo auth is refused when NODE_ENV=production;
//   - single origin: SPA fallback, asset caching, /api proxy, readiness;
//   - the mock product path end to end: demo sign-in -> trade -> outbox -> Redis -> SSE through nginx;
//     chat question -> durable job -> agent worker (mock SDK path) -> streamed events -> persisted answer;
//   - graceful shutdown: SIGTERM drains every role and each container exits 0.
// Usage: npm run verify:containers [-- --skip-build] [-- --keep]   (port 8080 must be free)
// Image tag: PORTFOLIO_PILOT_TAG (default "local"). No credentials are needed or read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const project = 'portfolio-pilot-smoke';
const origin = 'http://localhost:8080';
const tag = process.env.PORTFOLIO_PILOT_TAG ?? 'local';
const env = { ...process.env, MSYS_NO_PATHCONV: '1', PORTFOLIO_PILOT_TAG: tag,
  PORTFOLIO_PILOT_AUTH_SECRET: randomBytes(32).toString('base64url'), PORTFOLIO_PILOT_DB_PASSWORD: randomBytes(18).toString('base64url'),
  MOCK_NEWS_INTERVAL_MS: '2000', INGESTION_INTERVAL_MS: '2000',
  // A paced mock answer keeps the run (and its SSE frames) spread over time.
  AGENT_MOCK_STREAM_DELAY_MS: '150' };
const APP_SERVICES = ['api', 'web', 'worker-ingestion', 'worker-outbox', 'worker-agent'];
const results = [];
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

function run(command, commandArgs, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} ${commandArgs.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result;
}
const compose = (...rest) => run('docker', ['compose', '-p', project, '-f', 'compose.production.yaml', ...rest]);
const containerId = service => compose('ps', '-a', '-q', service).stdout.trim();
const inspect = service => JSON.parse(run('docker', ['inspect', containerId(service)]).stdout)[0];
async function check(name, body) {
  const started = Date.now();
  try { const detail = await body(); results.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) }); log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message }); log(`FAIL ${name}: ${error.stack ?? error}`); throw error; }
}
async function waitFor(label, probe, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { try { const value = await probe(); if (value) return value; } catch { /* retry */ } }
  throw new Error(`Timed out waiting for ${label}`);
}
async function call(cookie, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(origin + path, { method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text, headers: response.headers };
}
async function signIn(account) {
  const response = await fetch(`${origin}/api/auth/demo-sign-in`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ account }) });
  assert.equal(response.status, 200, `demo sign-in ${account}`);
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
/** Minimal EventSource over fetch, through the nginx origin, resuming from the recovery cursor. */
function openStream(cookie) {
  const stream = { events: [], arrivals: [], controller: new AbortController() };
  stream.done = (async () => {
    const recovery = await call(cookie, '/api/events/recovery');
    assert.equal(recovery.status, 200, 'recovery cursor');
    const response = await fetch(`${origin}/api/events`, { headers: { cookie, 'last-event-id': recovery.json.cursor, accept: 'text/event-stream' }, signal: stream.controller.signal });
    assert.equal(response.status, 200, 'event stream status');
    stream.contentType = response.headers.get('content-type');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) { stream.ended = Date.now(); return; }
      buffer += decoder.decode(value, { stream: true });
      for (let index; (index = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(index + 2)) {
        let type = null, data = null;
        for (const line of buffer.slice(0, index).split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim(); else if (line.startsWith('data:')) data = line.slice(5).trim();
        }
        if (type && data) { stream.events.push({ type, ...JSON.parse(data) }); stream.arrivals.push(Date.now()); }
      }
    }
  })().catch(error => { if (error.name !== 'AbortError') stream.error = error; });
  return stream;
}

let failed = false;
try {
  if (!args.has('--skip-build')) { log(`building images (tag ${tag})`); compose('build'); }
  log('starting the production-like stack');
  compose('up', '-d', '--wait', '--wait-timeout', '300');

  await check('every app container: non-root, read-only root filesystem, no capabilities, no-new-privileges', () => {
    const posture = {};
    for (const service of APP_SERVICES) {
      const info = inspect(service);
      const uid = run('docker', ['exec', info.Id, 'cat', '/proc/1/status']).stdout.match(/^Uid:\s+(\d+)/m)[1];
      assert.notEqual(uid, '0', `${service} PID 1 runs as root`);
      assert.ok(info.Config.User && !/^(0|root)(:|$)/.test(info.Config.User), `${service} image USER`);
      assert.equal(info.HostConfig.ReadonlyRootfs, true, `${service} read-only rootfs`);
      assert.deepEqual(info.HostConfig.CapDrop, ['ALL'], `${service} capabilities`);
      assert.ok(info.HostConfig.SecurityOpt?.includes('no-new-privileges:true'), `${service} no-new-privileges`);
      posture[service] = { uid: Number(uid), user: info.Config.User };
    }
    return posture;
  });

  await check('application code is read-only; the SDK workspace and session store are writable', () => {
    for (const [service, path] of [['api', '/app/apps/api/server.mjs'], ['worker-agent', '/app/apps/worker/dist/index.js']]) {
      const write = run('docker', ['exec', containerId(service), 'sh', '-c', `echo x >> ${path}`], { allowFailure: true, quiet: true });
      assert.notEqual(write.status, 0, `${service} could modify ${path}`);
    }
    for (const dir of ['/var/lib/portfolio-pilot/agent-workspace', '/var/lib/portfolio-pilot/session-artifacts']) {
      run('docker', ['exec', containerId('worker-agent'), 'sh', '-c', `touch ${dir}/.probe && rm ${dir}/.probe`]);
    }
  });

  await check('single origin: SPA fallback, cache policy, security headers and the /api proxy', async () => {
    const home = await call(null, '/');
    assert.equal(home.status, 200); assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    const deep = await call(null, '/portfolios/does-not-matter?tab=x');
    assert.equal(deep.status, 200); assert.equal(deep.text, home.text, 'deep link serves index.html');
    const asset = home.text.match(/\/assets\/[^"]+\.js/)[0];
    const script = await call(null, asset);
    assert.equal(script.status, 200); assert.match(script.headers.get('cache-control'), /immutable/);
    const missing = await call(null, '/assets/missing-0000.js');
    assert.equal(missing.status, 404); assert.equal(missing.headers.get('cache-control'), null, 'a 404 is never cached as immutable');
    assert.equal((await call(null, '/api')).status, 404);
    const ready = await call(null, '/api/health/ready');
    assert.equal(ready.status, 200); assert.equal(ready.json.status, 'ready');
    return { asset, ready: ready.json.dependencies };
  });

  const alice = await signIn('alice');
  const stream = openStream(alice);
  await waitFor('event stream connected', () => stream.contentType || stream.error);
  if (stream.error) throw stream.error;

  await check('trade -> outbox -> Redis -> SSE through nginx', async () => {
    assert.match(stream.contentType, /text\/event-stream/);
    const portfolio = (await call(alice, '/api/portfolios')).json.portfolios[0].id;
    const trade = await call(alice, `/api/portfolios/${portfolio}/transactions`, { method: 'POST', headers: { 'Idempotency-Key': `m33-smoke-${randomUUID()}` },
      body: { security: { symbol: 'ACME', exchangeMic: 'XNAS', currency: 'USD' }, side: 'BUY', quantity: '2', price: '10.50', fees: '0.25', occurredAt: '2025-01-10T15:00:00.000Z' } });
    assert.equal(trade.status, 200, `trade: ${trade.text}`); assert.equal(trade.json.replayed, false);
    const event = await waitFor('portfolio.updated over SSE', () => stream.events.find(e => e.type === 'portfolio.updated' && e.portfolioId === portfolio));
    const summary = await call(alice, `/api/portfolios/${portfolio}/summary`);
    assert.equal(summary.status, 200);
    return { portfolio, event: event.type };
  });

  await check('question -> agent worker (mock) -> streamed answer through nginx -> persisted message', async () => {
    const conversation = await call(alice, '/api/conversations', { method: 'POST', body: { title: 'Milestone 33 smoke' } });
    assert.equal(conversation.status, 201);
    const conversationId = conversation.json.conversation.id;
    const submitted = await call(alice, `/api/conversations/${conversationId}/runs`, { method: 'POST', body: { content: 'Explain my holdings' } });
    assert.equal(submitted.status, 202, `run: ${submitted.text}`);
    const runId = submitted.json.run.id;
    const completed = await waitFor('agent.run.completed over SSE', () => stream.events.find(e => e.type === 'agent.run.completed' && e.runId === runId), 60000);
    const runEvents = stream.events.filter(e => e.runId === runId);
    const deltas = runEvents.filter(e => e.type === 'agent.text.delta').length;
    assert.ok(runEvents.some(e => e.type === 'agent.run.started') && deltas >= 1, `run events: ${runEvents.map(e => e.type).join(',')}`);
    // Live delivery: every frame reached the client while the long-lived response is still open, so none
    // waited for the response (or a proxy buffer) to end. nginx sets proxy_buffering off and the API
    // also sends X-Accel-Buffering: no; arrival spread is reported, since outbox batching groups frames.
    assert.equal(stream.ended, undefined, 'the event stream ended before the run completed');
    const times = stream.events.map((e, i) => e.runId === runId ? stream.arrivals[i] : null).filter(Boolean);
    const reads = new Set(times).size;
    const messages = await call(alice, `/api/conversations/${conversationId}/messages`);
    assert.equal(messages.status, 200);
    assert.ok(JSON.stringify(messages.json).includes('assistant'), 'assistant message persisted');
    return { runId, outcome: completed.status ?? completed.outcome ?? 'completed', events: runEvents.length, deltas, reads, spreadMs: times.at(-1) - times[0] };
  });
  stream.controller.abort(); await stream.done;

  await check('bundled Claude Code CLI completes a turn against a local HTTP fixture (API and worker images, no network)', () => {
    const detail = {};
    for (const [image, from] of [[`portfolio-pilot-worker:${tag}`, '/app/packages/agent'], [`portfolio-pilot-api:${tag}`, '/app/apps/api']]) {
      const result = run('docker', ['run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'none',
        '--tmpfs', '/tmp', '--tmpfs', '/var/lib/portfolio-pilot/agent-workspace:uid=10001,gid=10001,mode=0700',
        '-v', `${join(root, 'docker', 'verify')}:/verify:ro`, '--entrypoint', 'node', image, '/verify/sdk-fixture-probe.mjs', from], { allowFailure: true, quiet: true });
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}');
      assert.equal(report.ok, true, `${image}: ${result.stdout}${result.stderr}`);
      detail[image] = { uid: report.uid, transcript: report.workspaceFiles.find(file => file.endsWith('.jsonl')) };
    }
    return detail;
  });

  await check('production profile refuses demo authentication (API and worker images)', () => {
    const production = ['-e', 'NODE_ENV=production', '-e', 'DATA_MODE=mock', '-e', 'DEMO_AUTH_ENABLED=true', '-e', 'AUTH_BASE_URL=http://localhost:8080'];
    for (const image of [`portfolio-pilot-api:${tag}`, `portfolio-pilot-worker:${tag}`]) {
      const result = run('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp', ...production, image], { allowFailure: true, quiet: true });
      assert.notEqual(result.status, 0, `${image} started with demo auth in production`);
      assert.match(result.stdout + result.stderr, /Demo authentication is forbidden in production/, `${image} refused for another reason`);
    }
  });

  await check('SIGTERM drains every role and each container exits 0', () => {
    compose('stop', '-t', '40', ...APP_SERVICES);
    const exits = {};
    for (const service of APP_SERVICES) {
      exits[service] = inspect(service).State.ExitCode;
      assert.equal(exits[service], 0, `${service} exit code ${exits[service]}`);
    }
    const logs = compose('logs', '--no-color', 'api', 'worker-agent', 'worker-outbox', 'worker-ingestion').stdout;
    assert.match(logs, /"event":"api\.drained"/);
    for (const role of ['agent', 'outbox', 'ingestion']) assert.match(logs, new RegExp(`"event":"worker\\.drained"[^\\n]*"role":"${role}"`));
    return exits;
  });
} catch (error) {
  failed = true;
  console.error(compose('logs', '--no-color', '--tail', '60').stdout);
} finally {
  if (!args.has('--keep')) compose('down', '-v', '--remove-orphans');
  console.log(JSON.stringify({ project, tag, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }, null, 2));
  process.exitCode = failed ? 1 : 0;
}
