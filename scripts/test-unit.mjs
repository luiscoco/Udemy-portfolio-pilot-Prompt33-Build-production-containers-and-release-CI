// `npm run test:unit` — every credential-free, infrastructure-free test (milestone 31).
// Runs each workspace's Vitest suite in its own directory (as `npm test` always has), excluding
// `*.integration.test.ts` (see `npm run test:integration`) and Playwright specs (`npm run test:browser`),
// plus the local proxy's node:test suite. Live provider/Claude/Azure tests are gated and reported
// by name as skipped; they never run without their explicit RUN_LIVE_* opt-in.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBuilt, PrerequisiteError, root } from './test-support/infra.mjs';
import { printSummary, vitestResult } from './test-support/report.mjs';

const workspaces = [
  ['packages/contracts'], ['packages/domain', 'src'], ['packages/config'], ['packages/providers'], ['packages/observability'],
  ['packages/db'], ['packages/agent'], ['apps/web', 'src'], ['apps/api'], ['apps/worker']
];
const only = process.argv.slice(2);
try {
  ensureBuilt('build:types', ['packages/contracts/dist/index.js', 'packages/db/dist/index.js', 'packages/agent/dist/index.js']);
} catch (error) {
  console.error(error.message); process.exit(error instanceof PrerequisiteError ? 2 : 1);
}
const out = mkdtempSync(join(tmpdir(), 'pp-unit-'));
const vitest = join(root, 'node_modules/vitest/vitest.mjs');
const rows = [];
for (const [dir, filter] of workspaces) {
  if (only.length && !only.some(name => dir.endsWith(name))) continue;
  const report = join(out, `${dir.replace('/', '-')}.json`);
  console.log(`\n--- ${dir}`);
  const args = [vitest, 'run', ...(filter ? [filter] : []), '--exclude', '**/*.integration.test.ts', '--exclude', 'e2e/**', '--passWithNoTests',
    '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
  const result = spawnSync(process.execPath, args, { cwd: join(root, dir), stdio: 'inherit', env: { ...process.env, TZ: 'UTC' }, windowsHide: true });
  const row = { name: dir, ...vitestResult(report) };
  if (row.crashed || (result.status !== 0 && row.failed === 0)) { row.failed++; row.failedNames.push(`${dir}: vitest exited ${result.status}`); }
  rows.push(row);
}
if (!only.length || only.includes('scripts')) {
  console.log('\n--- scripts (node:test)');
  const proxy = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'scripts/local-proxy.test.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
  process.stdout.write(proxy.stdout);
  const count = key => Number(proxy.stdout.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'))?.[1] ?? 0);
  rows.push({ name: 'scripts/local-proxy', passed: count('pass'), failed: count('fail') + (proxy.status !== 0 && !count('fail') ? 1 : 0), skipped: count('skipped'), failedNames: proxy.status ? ['scripts/local-proxy.test.mjs'] : [], skippedNames: [] });
}
const total = printSummary('Unit tests (no PostgreSQL, Redis, browser or credentials)', rows,
  ['\nLive tests above are skipped by design; see docs/verification-report.md for their opt-in variables.']);
process.exit(total.failed ? 1 : 0);
