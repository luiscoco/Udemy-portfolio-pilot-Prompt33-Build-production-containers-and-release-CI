// `npm run test:browser` — Chrome end-to-end tests against the real multi-replica topology
// (milestone 31). Nothing is mocked below the browser except where a spec deliberately controls the
// transport (news/streaming/provider-label specs). Per phase:
//   disposable PostgreSQL database (migrated + seeded) and Redis index
//   -> api-a + api-b (`apps/api/server.mjs`, the production entry point) behind the local proxy
//      (single origin serving the React build; test-only replica pinning via the `pp-upstream` cookie)
//   -> two mock agent workers and one outbox dispatcher (which also runs research/alert processing)
//   -> Playwright (Chrome channel, one worker so suites never compete for the demo users' limits).
// Phases exist only where a spec needs different server configuration; each gets a fresh database.
//
// Prerequisites: Docker (or TEST_POSTGRES_URL + TEST_REDIS_URL) and Google Chrome.
// Options: TEST_SKIP_BUILD=true, TEST_KEEP_INFRA=true, TEST_BROWSER_SKIP_OUTAGES=true, TEST_BROWSER_TRACE=true.
// Arguments filter specs by substring, e.g. `npm run test:browser -- fanout chat`.
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { ensureBuilt, freePort, PrerequisiteError, provision, root } from './test-support/infra.mjs';
import { printSummary } from './test-support/report.mjs';
import { createLocalProxy } from './local-proxy.mjs';

const PIN_COOKIE = 'pp-upstream';
const SCRUB = /^(OTEL_.*|PORTFOLIO_PILOT_TRACE_DIR|DATABASE_URL|REDIS_URL|.*_TEST_DATABASE_URL|.*_TEST_REDIS_URL|.*_E2E_DATABASE_URL|E2E_.*|NEWS_E2E|DISTRIBUTED_.*|ANTHROPIC_API_KEY|ALPACA_.*|AGENT_.*|DATA_MODE|RUN_LIVE_.*)$/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUB.test(key)));

/** Shared server settings: mock data and agent, generous limits so sequential specs never throttle. */
const SERVER = { NODE_ENV: 'development', DATA_MODE: 'mock', AGENT_MODE: 'mock', DEMO_AUTH_ENABLED: 'true',
  AUTH_SECRET: 'browser-suite-disposable-secret-0123456789abcdef', AGENT_DAILY_BUDGET_USD: '1000', AGENT_MAX_ACTIVE_RUNS_PER_USER: '6',
  AGENT_GLOBAL_CONCURRENCY: '6', AGENT_WORKER_CONCURRENCY: '3', AGENT_SUBMIT_RATE_LIMIT_PER_MINUTE: '500', API_RATE_LIMIT_PER_MINUTE: '20000',
  AGENT_MOCK_STREAM_DELAY_MS: '80', OUTBOX_POLL_MS: '100',
  // One deterministic mock market schedule shared by both replicas (each builds its feed lazily), with
  // the five-second interval the provider spec was written for (lesson 11).
  MOCK_NEWS_INTERVAL_MS: '5000', MOCK_START_AT: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), API_SHUTDOWN_GRACE_MS: '3000', WORKER_SHUTDOWN_GRACE_MS: '3000', OPS_REPORT_INTERVAL_MS: '3600000' };

const PHASES = [
  { name: 'main', specs: ['shell', 'providers', 'news', 'streaming', 'portfolio', 'fanout', 'article-recommendation', 'session-expiry',
    'chat', 'research', 'alerts', 'approvals', 'durable-workers', 'news-live'].map(s => `${s}.spec.ts`), env: {} },
  // Lesson 26 limits: immediate mock text, context reset after one turn, three-second wall clock,
  // and the default daily budget so the spec can exhaust it.
  { name: 'limits', specs: ['budgets.spec.ts'], env: { AGENT_MOCK_STREAM_DELAY_MS: '0', AGENT_CONTEXT_RESET_TURNS: '1', AGENT_WALL_CLOCK_MS: '3000', AGENT_DAILY_BUDGET_USD: undefined } },
  // Milestone 32: every process (both APIs, workers, and the injector the spec runs) writes spans to
  // one JSON-lines directory, so the spec can follow one article and one question across processes.
  { name: 'observability', specs: ['observability.spec.ts'], env: {}, traces: true },
  // Stops and restarts this run's own PostgreSQL/Redis containers; impossible with provided services.
  { name: 'outages', specs: ['distributed-recovery.spec.ts'], env: {}, requiresOwnedContainers: true }
];

const filters = process.argv.slice(2);
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const rows = [], notes = [];
let infra;
const children = [];

function start(name, script, env, cwd) {
  const child = fork(script, [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const output = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output.push(String(b)); if (output.length > 400) output.shift(); });
  const entry = { name, child, output, exited: once(child, 'exit') };
  children.push(entry);
  return entry;
}
async function stopAll() {
  const live = children.splice(0).filter(c => c.child.exitCode === null && c.child.signalCode === null);
  for (const { child } of live) if (child.connected) child.send('shutdown');
  await Promise.race([Promise.all(live.map(c => c.exited)), sleep(10000)]);
  for (const { child } of live) if (child.exitCode === null && child.signalCode === null) child.kill();
}
async function waitReady(url, entry, ms = 90000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    if (entry.child.exitCode !== null) throw new Error(`${entry.name} exited during startup:\n${entry.output.join('').slice(-3000)}`);
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
  }
  throw new Error(`${entry.name} was not ready within ${ms} ms:\n${entry.output.join('').slice(-3000)}`);
}

/** Walks a Playwright JSON report into a summary row. */
function playwrightRow(name, file) {
  const row = { name, passed: 0, failed: 0, skipped: 0, failedNames: [], skippedNames: [] };
  if (!existsSync(file)) { row.failed++; row.failedNames.push(`${name}: Playwright produced no report`); return row; }
  const visit = (suite, path) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const label = `${spec.file ?? suite.file} > ${[...path, spec.title].filter(Boolean).join(' > ')}`;
      if (test.status === 'expected' || test.status === 'flaky') { row.passed++; if (test.status === 'flaky') row.failedNames.push(`${label} (FLAKY: passed on retry)`); }
      else if (test.status === 'skipped') { row.skipped++; row.skippedNames.push(`${label} — ${(test.annotations ?? []).map(a => a.description).filter(Boolean).join('; ') || 'skipped'}`); }
      else { row.failed++; row.failedNames.push(label); }
    }
    for (const child of suite.suites ?? []) visit(child, [...path, child.title === child.file ? '' : child.title]);
  };
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const suite of report.suites ?? []) visit(suite, []);
  for (const error of report.errors ?? []) { row.failed++; row.failedNames.push(`${name}: ${String(error.message ?? error).split('\n')[0]}`); }
  return row;
}

async function runPhase(phase, specs, out) {
  log(`== phase ${phase.name}: ${specs.join(', ')}`);
  const databaseUrl = await infra.database(`e2e_${phase.name}`);
  const redisUrl = await infra.redis(PHASES.indexOf(phase) + 1);
  // Seed the deterministic demo users/portfolios with the compiled seed (fixed fixture clock).
  const { getDatabase, closeConnections } = await import(pathToFileURL(join(root, 'packages/db/dist/index.js')).href);
  const { seedDemo } = await import(pathToFileURL(join(root, 'packages/db/dist/seed.js')).href);
  await seedDemo(await getDatabase(databaseUrl)); await closeConnections();

  const [proxyPort, apiA, apiB] = [await freePort(), await freePort(), await freePort()];
  const origin = `http://127.0.0.1:${proxyPort}`;
  const traces = phase.traces ? { OTEL_TRACES_EXPORTER: 'file', PORTFOLIO_PILOT_TRACE_DIR: mkdtempSync(join(tmpdir(), 'pp-e2e-traces-')) } : {};
  if (phase.traces) log(`   trace files: ${traces.PORTFOLIO_PILOT_TRACE_DIR} (npm run trace:inspect -- --dir <that directory>)`);
  const env = { ...baseEnv, ...SERVER, ...phase.env, ...traces, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, AUTH_BASE_URL: origin,
    SESSION_ARTIFACT_DIR: mkdtempSync(join(tmpdir(), 'pp-e2e-artifacts-')), AGENT_WORKSPACE_DIR: mkdtempSync(join(tmpdir(), 'pp-e2e-workspace-')) };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const apis = [['api-a', apiA], ['api-b', apiB]].map(([name, port]) =>
    [start(name, join(root, 'apps/api/server.mjs'), { ...env, INSTANCE_ID: name, PORT: String(port) }, join(root, 'apps/api')), port]);
  for (const [entry, port] of apis) await waitReady(`http://127.0.0.1:${port}/api/health/live`, entry);
  for (const name of ['agent-1', 'agent-2']) start(name, join(root, 'apps/worker/dist/index.js'), { ...env, INSTANCE_ID: name, WORKER_ROLE: 'agent' }, root);
  start('outbox-1', join(root, 'apps/worker/dist/index.js'), { ...env, INSTANCE_ID: 'outbox-1', WORKER_ROLE: 'outbox' }, root);
  const proxy = createLocalProxy({ upstreams: [`http://127.0.0.1:${apiA}`, `http://127.0.0.1:${apiB}`], staticDir: join(root, 'apps/web/dist'), pinCookie: PIN_COOKIE, healthIntervalMs: 250 });
  proxy.server.listen(proxyPort, '127.0.0.1'); await once(proxy.server, 'listening'); await proxy.probes();
  log(`   topology ready: ${origin} -> api-a:${apiA}, api-b:${apiB}; agent-1, agent-2, outbox-1`);

  const report = join(out, `${phase.name}.json`);
  const testEnv = { ...baseEnv, NODE_ENV: 'development', DATA_MODE: 'mock', E2E_BASE_URL: origin, E2E_DATABASE_URL: databaseUrl, E2E_PIN_COOKIE: PIN_COOKIE,
    DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, NEWS_E2E: 'true', PLAYWRIGHT_JSON_OUTPUT_NAME: report, ...traces,
    ...(phase.requiresOwnedContainers ? { DISTRIBUTED_UI_BASE_URL: origin, DISTRIBUTED_PG_CONTAINER: infra.pgContainer, DISTRIBUTED_REDIS_CONTAINER: infra.redisContainer } : {}) };
  const playwright = spawn(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.config.ts', '--workers=1',
    '--reporter=list,json', ...(process.env.TEST_BROWSER_TRACE === 'true' ? ['--trace=retain-on-failure'] : []), ...specs.map(s => `e2e/${s}`)], { cwd: join(root, 'apps/web'), env: testEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const output = [];
  for (const stream of [playwright.stdout, playwright.stderr]) stream.on('data', b => { process.stdout.write(b); output.push(String(b)); });
  const [code] = await once(playwright, 'exit');
  const text = output.join('');
  if (/Chromium distribution 'chrome' is not found|chrome.*not found|Executable doesn't exist/i.test(text)) {
    proxy.server.close(); await stopAll();
    throw new PrerequisiteError('Google Chrome is required (playwright.config.ts uses channel "chrome"). Install Chrome, or run: npx playwright install chrome');
  }
  const row = playwrightRow(`phase ${phase.name}`, report);
  if (code !== 0 && row.failed === 0) { row.failed++; row.failedNames.push(`phase ${phase.name}: Playwright exited ${code}`); }
  if (row.failed) for (const entry of children) {
    const lines = entry.output.join('').split('\n').filter(l => /error|fail|exception/i.test(l)).slice(-8);
    if (lines.length) console.log(`\n[${entry.name} recent errors]\n${lines.join('\n')}`);
  }
  rows.push(row);
  proxy.server.closeAllConnections?.(); proxy.server.close();
  await stopAll();
}

process.on('SIGINT', () => { void stopAll().then(() => infra?.dispose()).finally(() => process.exit(130)); });
try {
  ensureBuilt('build', ['apps/api/.next/BUILD_ID', 'apps/web/dist/index.html', 'apps/worker/dist/index.js', 'packages/db/dist/seed.js']);
  infra = await provision('e2e');
  const out = mkdtempSync(join(tmpdir(), 'pp-browser-'));
  for (const phase of PHASES) {
    const specs = phase.specs.filter(s => !filters.length || filters.some(f => s.includes(f)));
    if (!specs.length) continue;
    if (phase.requiresOwnedContainers && (!infra.pgContainer || process.env.TEST_BROWSER_SKIP_OUTAGES === 'true')) {
      notes.push(`SKIPPED phase ${phase.name} (${specs.join(', ')}): ${infra.pgContainer ? 'TEST_BROWSER_SKIP_OUTAGES=true' : 'it stops and restarts its database containers, which only this harness may do; provided TEST_POSTGRES_URL/TEST_REDIS_URL services are never stopped'}.`);
      rows.push({ name: `phase ${phase.name}`, passed: 0, failed: 0, skipped: specs.length, skippedNames: specs.map(s => `${s} (phase not run)`), failedNames: [] });
      continue;
    }
    await runPhase(phase, specs, out);
  }
} catch (error) {
  await stopAll();
  if (error instanceof PrerequisiteError) {
    console.error(`\nPREREQUISITE MISSING: ${error.message}\nBrowser tests did not run to completion; this is not a pass.`);
    await infra?.dispose();
    process.exit(2);
  }
  console.error(error);
  rows.push({ name: 'harness', passed: 0, failed: 1, skipped: 0, failedNames: [String(error.message).split('\n')[0]], skippedNames: [] });
} finally {
  await stopAll();
  await infra?.dispose();
}
const total = printSummary('Browser tests (Chrome; two API replicas behind one origin; mock agent and data)', rows, notes.length ? ['', ...notes] : []);
process.exit(total.failed ? 1 : 0);
