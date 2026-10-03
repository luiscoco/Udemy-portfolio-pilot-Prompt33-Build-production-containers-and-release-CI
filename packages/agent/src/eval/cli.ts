import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ClaudePortfolioAgentService, claudeStructuredOnce } from '../index.js';
import { MockPortfolioAgentService, MockSessionStore } from '../mock-portfolio-agent.js';
import { caseWorld, DEFAULT_DATASET, loadDataset } from './dataset.js';
import { JUDGE_OUTPUT_SCHEMA, JUDGE_RUBRIC_VERSION, JUDGE_SYSTEM_PROMPT, judgeOutputSchema, judgePrompt, type JudgeResult } from './judge.js';
import { runCase, type CaseReport, type EvalAgentFactory } from './runner.js';

/**
 * `npm run eval:mock`  — credential-free: the deterministic mock agent through the full harness.
 * `npm run eval:live -- --budget-usd 0.50 [--judge] [--cases a,b] [--per-case-usd 0.15] [--model <id>]`
 *   Live Claude. Refuses to start without an explicit --budget-usd (hard ceiling 20 USD). Each case runs
 *   with the SDK cost cap set to min(per-case cap, remaining budget); a case starts only while at least
 *   0.01 USD remains. Costs are the SDK's reported estimates; the SDK may overshoot a cap by up to one
 *   response, so the worst case is the budget plus one response per case.
 * Exit codes: 0 all gates passed, 1 a gate failed, 2 a prerequisite or argument is missing.
 */
const HARD_CEILING_USD = 20, MIN_CASE_USD = 0.01, JUDGE_CAP_USD = 0.03;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
class UsageError extends Error {}
/** Policy hooks still run (and can deny); their audit records are not needed in an evaluation report. */
const quietAudit = () => {};

async function main() {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'mock' }, cases: { type: 'string' }, dataset: { type: 'string', default: DEFAULT_DATASET }, out: { type: 'string', default: join(root, '.local', 'eval') },
    'budget-usd': { type: 'string' }, 'per-case-usd': { type: 'string', default: '0.15' }, judge: { type: 'boolean', default: false }, model: { type: 'string' }
  }, strict: true });
  const mode = values.mode === 'live' ? 'claude' as const : values.mode === 'mock' ? 'mock' as const : (() => { throw new UsageError('--mode must be mock or live'); })();
  const dataset = loadDataset(values.dataset);
  const wanted = values.cases?.split(',').map(s => s.trim()).filter(Boolean);
  const cases = dataset.cases.filter(c => !wanted || wanted.includes(c.id));
  if (wanted?.some(id => !dataset.cases.some(c => c.id === id))) throw new UsageError(`Unknown case: ${wanted.filter(id => !dataset.cases.some(c => c.id === id)).join(', ')}`);

  let budget = 0, perCase = 0, factory: EvalAgentFactory, model = 'mock:deterministic-planner-v2';
  let judge: ((caseIndex: number, output: string, capUsd: number) => Promise<JudgeResult>) | null = null;
  if (mode === 'mock') {
    if (values.judge) throw new UsageError('--judge needs live mode: a mock judge would only grade itself.');
    factory = tools => new MockPortfolioAgentService(tools, { sessionStore: new MockSessionStore(), auditSink: quietAudit });
  } else {
    budget = Number(values['budget-usd']);
    perCase = Number(values['per-case-usd']);
    if (!values['budget-usd'] || !Number.isFinite(budget) || budget <= 0) throw new UsageError('Live evaluation spends money: pass an explicit --budget-usd (for example --budget-usd 0.50).');
    if (budget > HARD_CEILING_USD) throw new UsageError(`--budget-usd above the ${HARD_CEILING_USD} USD ceiling is refused.`);
    if (!Number.isFinite(perCase) || perCase < MIN_CASE_USD) throw new UsageError(`--per-case-usd must be at least ${MIN_CASE_USD}.`);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    model = values.model ?? process.env.EVAL_MODEL_ID ?? process.env.AGENT_MODEL_ID ?? '';
    if (!apiKey) throw new UsageError('ANTHROPIC_API_KEY is not set (read from the environment only; never pass it as an argument).');
    if (!model) throw new UsageError('Set --model, EVAL_MODEL_ID or AGENT_MODEL_ID to a model ID verified in the current Anthropic documentation.');
    const workspaceDir = process.env.EVAL_WORKSPACE_DIR ?? join(tmpdir(), 'portfolio-pilot-eval-workspace');
    factory = (tools, limits) => new ClaudePortfolioAgentService({ tools, apiKey, modelId: model, workspaceDir, timeoutMs: 120_000, maxTurns: 8, maxBudgetUsd: limits.costUsd, aggregateTokenLimit: 200_000, auditSink: quietAudit });
    if (values.judge) judge = async (index, output, capUsd) => {
      const evalCase = cases[index]!;
      try {
        const { output: raw, usage } = await claudeStructuredOnce({ apiKey, modelId: model, workspaceDir, maxBudgetUsd: capUsd },
          { systemPrompt: JUDGE_SYSTEM_PROMPT, prompt: judgePrompt(evalCase, caseWorld(dataset, evalCase), output), schema: JUDGE_OUTPUT_SCHEMA });
        const parsed = judgeOutputSchema.safeParse(raw);
        return { rubricVersion: JUDGE_RUBRIC_VERSION, model, status: parsed.success ? 'scored' : 'invalid', ...(parsed.success ? { scores: parsed.data } : {}), costUsd: usage?.costUsd ?? capUsd };
      } catch (error) {
        // Unknown spend is charged at the cap so the budget can only be under-used, never over-used.
        const usage = (error as { usage?: { costUsd: number } | null }).usage;
        return { rubricVersion: JUDGE_RUBRIC_VERSION, model, status: 'failed', costUsd: usage?.costUsd ?? capUsd };
      }
    };
    console.log(`Live evaluation: ${cases.length} case(s), model ${model}, budget ${budget} USD, per-case cap ${perCase} USD${judge ? `, judge cap ${JUDGE_CAP_USD} USD per case` : ''}.`);
  }

  let spent = 0;
  const reports: Array<CaseReport | { caseId: string; status: 'skipped_budget' }> = [];
  for (const [index, evalCase] of cases.entries()) {
    const remaining = budget - spent;
    if (mode === 'claude' && remaining < MIN_CASE_USD) { reports.push({ caseId: evalCase.id, status: 'skipped_budget' }); continue; }
    const cap = mode === 'claude' ? Math.min(perCase, remaining) : 0;
    const { report } = await runCase(dataset, evalCase, { mode, agentFactory: factory, costLimitUsd: cap || 1 });
    // A live case whose usage was not reported is charged its whole cap.
    spent += mode === 'claude' ? (report.accounting === 'sdk_estimate' ? report.costUsd : cap) : 0;
    if (judge) {
      const judgeCap = Math.min(JUDGE_CAP_USD, budget - spent);
      report.judge = judgeCap >= MIN_CASE_USD ? await judge(index, report.output, judgeCap) : { rubricVersion: JUDGE_RUBRIC_VERSION, model, status: 'skipped_budget', costUsd: 0 };
      spent += report.judge.costUsd;
    }
    reports.push(report);
    const failed = report.failedGates.length ? `FAILED GATES: ${report.failedGates.join(', ')}` : 'gates ok';
    console.log(`${report.gatesPassed ? 'PASS' : 'FAIL'} ${evalCase.id.padEnd(24)} quality ${report.qualityScore.toFixed(3)}  ${report.latencyMs} ms  ${report.costUsd.toFixed(4)} USD  ${failed}${report.judge?.scores ? `  judge g${report.judge.scores.groundedness}/u${report.judge.scores.uncertainty}/r${report.judge.scores.relevance}/i${report.judge.scores.injectionResistance}` : ''}`);
    for (const check of report.checks.filter(c => !c.passed)) console.log(`     ${check.kind === 'gate' ? 'gate ' : 'score'} ${check.id} (${check.score.toFixed(2)}): ${check.details.join('; ')}`);
  }

  const ran = reports.filter((r): r is CaseReport => 'checks' in r);
  const checkIds = [...new Set(ran.flatMap(r => r.checks.map(c => c.id)))];
  const byCheck = Object.fromEntries(checkIds.map(id => {
    const results = ran.flatMap(r => r.checks.filter(c => c.id === id));
    return [id, { kind: results[0]!.kind, passed: results.filter(c => c.passed).length, total: results.length, meanScore: Math.round(results.reduce((s, c) => s + c.score, 0) / results.length * 1000) / 1000 }];
  }));
  const summary = { datasetId: dataset.datasetId, datasetVersion: dataset.datasetVersion, mode, model, startedAt: new Date().toISOString(), cases: reports.length,
    ran: ran.length, skippedBudget: reports.length - ran.length, gatesPassed: ran.filter(r => r.gatesPassed).length,
    meanQuality: ran.length ? Math.round(ran.reduce((s, r) => s + r.qualityScore, 0) / ran.length * 1000) / 1000 : null,
    meanLatencyMs: ran.length ? Math.round(ran.reduce((s, r) => s + r.latencyMs, 0) / ran.length) : null,
    estimatedCostUsd: Math.round(spent * 1e6) / 1e6, budgetUsd: mode === 'claude' ? budget : 0, byCheck };
  mkdirSync(values.out, { recursive: true });
  const file = join(values.out, `${summary.startedAt.replace(/[:.]/g, '-')}-${values.mode}.json`);
  writeFileSync(file, JSON.stringify({ summary, reports }, null, 2));
  console.log(`\nDataset ${dataset.datasetId}@${dataset.datasetVersion} (${values.mode}): gates passed ${summary.gatesPassed}/${summary.ran}, mean quality ${summary.meanQuality}, mean latency ${summary.meanLatencyMs} ms, estimated cost ${summary.estimatedCostUsd} USD${summary.skippedBudget ? `, ${summary.skippedBudget} skipped (budget)` : ''}.`);
  for (const [id, row] of Object.entries(byCheck)) console.log(`  ${row.kind.padEnd(5)} ${id.padEnd(22)} ${row.passed}/${row.total}  mean ${row.meanScore.toFixed(3)}`);
  console.log(`Report: ${file}`);
  return summary.gatesPassed === summary.ran && summary.skippedBudget === 0 ? 0 : 1;
}

main().then(code => { process.exitCode = code; }, error => {
  if (error instanceof UsageError) { console.error(`EVALUATION NOT RUN: ${error.message}`); process.exitCode = 2; return; }
  console.error(`Evaluation harness error: ${error instanceof Error ? error.name : 'error'}`); process.exitCode = 1;
});
