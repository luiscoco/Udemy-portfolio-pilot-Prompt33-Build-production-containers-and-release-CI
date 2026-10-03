// Shared result reporting for the three test commands (milestone 31). Skips are listed by name so a
// gated live test can never be mistaken for a pass.
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { root } from './infra.mjs';

/** Reads a Vitest JSON report into { passed, failed, skipped, skippedNames, failedNames }. */
export function vitestResult(file) {
  const result = { passed: 0, failed: 0, skipped: 0, files: 0, skippedNames: [], failedNames: [], crashed: !existsSync(file) };
  if (result.crashed) return result;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  for (const suite of json.testResults ?? []) {
    result.files++;
    const name = relative(root, suite.name).replaceAll('\\', '/');
    if (suite.status === 'failed' && !(suite.assertionResults ?? []).some(t => t.status === 'failed')) {
      result.failed++; result.failedNames.push(`${name}: ${String(suite.message ?? 'suite failed to load').split('\n')[0]}`);
    }
    for (const test of suite.assertionResults ?? []) {
      if (test.status === 'passed') result.passed++;
      else if (test.status === 'failed') { result.failed++; result.failedNames.push(`${name} > ${test.fullName}`); }
      else { result.skipped++; result.skippedNames.push(`${name} > ${test.fullName}`); }
    }
  }
  return result;
}

export function printSummary(title, rows, extra = []) {
  const width = Math.max(...rows.map(r => r.name.length), 10);
  console.log(`\n=== ${title} ===`);
  console.log(`${'suite'.padEnd(width)}  passed  failed  skipped`);
  for (const r of rows) console.log(`${r.name.padEnd(width)}  ${String(r.passed).padStart(6)}  ${String(r.failed).padStart(6)}  ${String(r.skipped).padStart(7)}${r.note ? `  ${r.note}` : ''}`);
  const total = rows.reduce((t, r) => ({ passed: t.passed + r.passed, failed: t.failed + r.failed, skipped: t.skipped + r.skipped }), { passed: 0, failed: 0, skipped: 0 });
  console.log(`${'TOTAL'.padEnd(width)}  ${String(total.passed).padStart(6)}  ${String(total.failed).padStart(6)}  ${String(total.skipped).padStart(7)}`);
  const failed = rows.flatMap(r => r.failedNames ?? []);
  if (failed.length) { console.log('\nFAILED:'); for (const name of failed) console.log(`  - ${name}`); }
  const skipped = rows.flatMap(r => r.skippedNames ?? []);
  if (skipped.length) { console.log('\nSKIPPED (not verified by this run):'); for (const name of skipped) console.log(`  - ${name}`); }
  for (const line of extra) console.log(line);
  return total;
}
