// `npm run test:integration` — every PostgreSQL/Redis acceptance suite against disposable
// infrastructure (milestone 31). Each suite file gets its own freshly migrated database (cloned from
// a template) and its own flushed Redis logical database, so suites cannot see each other's rows,
// streams, leases or counters. Real worker processes are spawned by the suites that need them; the
// agent is always the deterministic mock adapter, so no credentials or paid services are used.
//
// Prerequisites: Docker (default) or TEST_POSTGRES_URL + TEST_REDIS_URL (see test-support/infra.mjs).
// Options: TEST_INTEGRATION_CONCURRENCY (default 3), TEST_SKIP_BUILD=true, TEST_KEEP_INFRA=true.
// Arguments filter suites by substring, e.g. `npm run test:integration -- approvals outbox`.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBuilt, PrerequisiteError, provision, root } from './test-support/infra.mjs';
import { printSummary, vitestResult } from './test-support/report.mjs';

/** Suite file -> the variables it reads. `db`/`redis` name the suite's own gate variables. */
const SUITES = [
  { file: 'apps/api/lib/auth.integration.test.ts', db: 'AUTH_TEST_DATABASE_URL' },
  { file: 'apps/api/lib/portfolio.integration.test.ts', db: 'PORTFOLIO_TEST_DATABASE_URL' },
  { file: 'apps/api/lib/events.integration.test.ts', db: 'SSE_TEST_DATABASE_URL', redis: 'SSE_TEST_REDIS_URL' },
  { file: 'apps/api/lib/agent-tools.integration.test.ts', db: 'AGENT_TOOLS_TEST_DATABASE_URL' },
  { file: 'apps/api/lib/chat.integration.test.ts', db: 'CHAT_TEST_DATABASE_URL', redis: 'CHAT_TEST_REDIS_URL' },
  { file: 'apps/api/lib/conversation-sessions.integration.test.ts', db: 'SESSION_TEST_DATABASE_URL' },
  { file: 'apps/api/lib/research.integration.test.ts', db: 'RESEARCH_TEST_DATABASE_URL' },
  { file: 'apps/api/lib/alerts.integration.test.ts', db: 'ALERT_TEST_DATABASE_URL', redis: 'ALERT_TEST_REDIS_URL' },
  { file: 'apps/api/lib/approvals.integration.test.ts', db: 'APPROVAL_TEST_DATABASE_URL' },
  { file: 'apps/api/lib/budgets.integration.test.ts', db: 'BUDGET_TEST_DATABASE_URL' },
  { file: 'apps/worker/test/ingestion.integration.test.ts', db: 'INGESTION_TEST_DATABASE_URL' },
  { file: 'apps/worker/test/outbox.integration.test.ts', db: 'OUTBOX_TEST_DATABASE_URL', redis: 'OUTBOX_TEST_REDIS_URL' },
  { file: 'apps/worker/test/news.integration.test.ts', db: 'NEWS_TEST_DATABASE_URL' },
  { file: 'apps/worker/test/agent-jobs.integration.test.ts', db: 'AGENT_JOBS_TEST_DATABASE_URL' },
  { file: 'apps/worker/test/session-artifacts.integration.test.ts', db: 'SESSION_ARTIFACT_TEST_DATABASE_URL' },
  { file: 'apps/worker/test/operations.integration.test.ts', db: 'OPERATIONS_TEST_DATABASE_URL' }
];
// Variables the developer's shell may carry that would point a suite at another environment.
const SCRUB = /^(DATABASE_URL|REDIS_URL|.*_TEST_DATABASE_URL|.*_TEST_REDIS_URL|.*_E2E_DATABASE_URL|ANTHROPIC_API_KEY|ALPACA_.*|AGENT_MODE|DATA_MODE|RUN_LIVE_.*)$/;

const filters = process.argv.slice(2);
const selected = SUITES.filter(s => !filters.length || filters.some(f => s.file.includes(f)));
if (!selected.length) { console.error(`No integration suite matches: ${filters.join(', ')}`); process.exit(2); }
const concurrency = Math.max(1, Math.min(8, Number(process.env.TEST_INTEGRATION_CONCURRENCY ?? 3)));
const out = mkdtempSync(join(tmpdir(), 'pp-integration-'));
const vitest = join(root, 'node_modules/vitest/vitest.mjs');
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUB.test(key)));

let infra;
const rows = [];
try {
  ensureBuilt('build:types', ['packages/db/dist/index.js']);
  ensureBuilt('build --workspace=@portfolio-pilot/worker', ['apps/worker/dist/index.js']);
  infra = await provision('int');
  const freeRedis = Array.from({ length: 15 }, (_, i) => i + 1);
  const queue = [...selected];
  async function runSuite(suite) {
    const workspace = suite.file.startsWith('apps/api/') ? 'apps/api' : 'apps/worker';
    const relativeFile = suite.file.slice(workspace.length + 1);
    const name = suite.file.split('/').at(-1).replace('.integration.test.ts', '');
    const databaseUrl = await infra.database(name);
    const index = freeRedis.shift();
    const redisUrl = await infra.redis(index);
    const report = join(out, `${name}.json`);
    // The suite's own gate variables plus the ordinary DATABASE_URL/REDIS_URL some route handlers read.
    const env = { ...baseEnv, TZ: 'UTC', NODE_ENV: 'test', DATA_MODE: 'mock', AGENT_MODE: 'mock', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl,
      [suite.db]: databaseUrl, ...(suite.redis ? { [suite.redis]: redisUrl } : {}) };
    const started = Date.now();
    const output = [];
    const child = spawn(process.execPath, [vitest, 'run', relativeFile, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`],
      { cwd: join(root, workspace), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => output.push(b)); child.stderr.on('data', b => output.push(b));
    const code = await new Promise(resolve => child.on('exit', resolve));
    freeRedis.push(index);
    const row = { name: suite.file, ...vitestResult(report), note: `${((Date.now() - started) / 1000).toFixed(1)}s` };
    if (row.crashed || (code !== 0 && row.failed === 0)) { row.failed++; row.failedNames.push(`${suite.file}: vitest exited ${code}`); }
    // A suite gated off by its own variables would silently "pass" with zero tests; treat as failure.
    if (row.passed === 0 && row.failed === 0) { row.failed++; row.failedNames.push(`${suite.file}: no test ran (gate variables not honoured?)`); }
    const text = Buffer.concat(output).toString();
    console.log(`\n--- ${suite.file} (${row.passed} passed, ${row.failed} failed, ${row.skipped} skipped, ${row.note})`);
    if (row.failed || process.env.TEST_VERBOSE === 'true') process.stdout.write(text.slice(-12000));
    rows.push(row);
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await runSuite(queue.shift());
  }));
} catch (error) {
  if (error instanceof PrerequisiteError) {
    console.error(`\nPREREQUISITE MISSING: ${error.message}\nNo integration test was run; this is not a pass.`);
    await infra?.dispose();
    process.exit(2);
  }
  throw error;
} finally {
  await infra?.dispose();
}
rows.sort((a, b) => SUITES.findIndex(s => s.file === a.name) - SUITES.findIndex(s => s.file === b.name));
const total = printSummary('Integration tests (disposable PostgreSQL + Redis, mock agent, real worker processes)', rows);
process.exit(total.failed ? 1 : 0);
