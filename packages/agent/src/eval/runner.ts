import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { ANALYSIS_POLICY, analysisCorrection, NEWS_ANALYSIS_OUTPUT_SCHEMA, renderNewsAnalysis, validateNewsAnalysis, type AnalysisValidation } from '../analysis.js';
import { buildResearchPrompt, researchContext } from '../research-context.js';
import { AgentRunFailure } from '../errors.js';
import type { PortfolioToolContext } from '../tools/context.js';
import type { AgentRunResult, StreamingAgentService } from '../streaming.js';
import type { ResearchUsage } from '../delegation.js';
import { caseWorld, fixturePort, type EvalCase, type EvalDataset } from './dataset.js';
import { evaluateCase, summarizeChecks, type CheckResult, type EvalObservation } from './checks.js';

export type EvalAgentFactory = (tools: PortfolioToolContext, limits: { costUsd: number }) => StreamingAgentService;
export interface CaseReport {
  caseId: string; title: string; traps: string[]; kind: EvalCase['kind'];
  status: EvalObservation['status']; failureCode: string | null; attempts: number;
  latencyMs: number; costUsd: number; accounting: EvalObservation['accounting']; aggregateTokens: number;
  toolCalls: EvalObservation['toolCalls']; cited: string[];
  checks: CheckResult[]; gatesPassed: boolean; failedGates: string[]; qualityScore: number;
  judge?: import('./judge.js').JudgeResult;
  /** The rendered output, kept in the local report for human review of failures (synthetic data only). */
  output: string;
}

/**
 * Runs one case through the SAME production pieces the agent worker uses: the authorized prompt
 * builder, the owner-bound tool server, the per-run evidence registry, `validateNewsAnalysis`, the
 * bounded correction retry and the server-side Markdown rendering. Persistence, SSE and approvals
 * are replaced by in-memory equivalents; the approval port records and DENIES every proposal.
 */
export async function runCase(dataset: EvalDataset, evalCase: EvalCase, options: { mode: 'mock' | 'claude'; agentFactory: EvalAgentFactory; costLimitUsd: number }): Promise<{ report: CaseReport; observation: EvalObservation }> {
  const world = caseWorld(dataset, evalCase);
  const data = fixturePort(dataset, world);
  const toolResults: string[] = [];
  let proposals = 0;
  const tools: PortfolioToolContext = { data, dataMode: 'mock', now: () => new Date(world.now), onResult: (_name, value) => { toolResults.push(JSON.stringify(value)); },
    approval: { rules: async () => [], authorize: async () => { proposals++; return false; }, execute: async () => { throw new AgentRunFailure('approval_required'); } } };
  const context = researchContext(tools);
  const toolCalls = new Map<string, { tool: string; status: string }>();
  let usage: ResearchUsage | null = null;
  let spent = 0;
  const messageId = `eval-${randomUUID()}`;
  const agent = options.agentFactory(context.tools, { costUsd: options.costLimitUsd });
  const started = performance.now();
  let status: EvalObservation['status'] = 'completed', failureCode: string | null = null, attempts = 0;
  let result: AgentRunResult | null = null, validation: AnalysisValidation | null = null, firstAttemptValid: boolean | null = null, finalText = '';
  const attempt = async (correction?: string[]) => {
    attempts++;
    const prompt = await buildResearchPrompt(context.tools, { portfolioId: dataset.owner.portfolioId, content: evalCase.question, kind: evalCase.kind, continuity: 'new', ...(correction ? { correction } : {}) });
    const remaining = Math.max(0.000001, options.costLimitUsd - spent);
    const output = await agent.stream({ prompt, messageId, resumeSessionId: null,
      limits: { promptBytes: 48000, toolResultBytes: 24000, turns: 8, costUsd: remaining },
      onEvent: event => { if (event.type === 'tool.status') toolCalls.set(event.toolCallId, { tool: event.tool, status: event.status }); },
      onUsage: reported => { usage = reported; },
      audit: { actorId: 'evaluation', conversationId: null, runId: messageId },
      ...(evalCase.kind === 'news_analysis' ? { outputSchema: NEWS_ANALYSIS_OUTPUT_SCHEMA } : {}) });
    const reported = output.usage ?? usage;
    if (reported) { spent += reported.costUsd; usage = null; aggregate.tokens += reported.aggregateTokens; aggregate.reported++; }
    return output;
  };
  const aggregate = { tokens: 0, reported: 0 };
  try {
    result = await attempt();
    if (evalCase.kind === 'news_analysis') {
      for (;;) {
        validation = validateNewsAnalysis(result.structuredOutput, context.evidence(), world.now);
        firstAttemptValid ??= validation.ok;
        if (validation.ok) break;
        if (attempts >= ANALYSIS_POLICY.maxAttempts) throw new AgentRunFailure(validation.code);
        result = await attempt(analysisCorrection(validation));
      }
      finalText = renderNewsAnalysis(validation.analysis, context.evidence());
    } else finalText = result.text;
  } catch (error) {
    status = 'failed';
    failureCode = error instanceof AgentRunFailure ? error.code : error instanceof Error && /^\w{1,40}$/.test(error.name) ? error.name : 'error';
  } finally { await agent.cleanup?.(); }
  const latencyMs = performance.now() - started;
  const observation: EvalObservation = {
    caseId: evalCase.id, mode: options.mode, kind: evalCase.kind, status, failureCode, finalText, structured: result?.structuredOutput ?? null, validation, attempts, firstAttemptValid,
    analysis: validation?.ok ? validation.analysis : null, read: context.sources(), toolCalls: [...toolCalls.values()], proposals, toolResults, latencyMs,
    costUsd: Math.round(spent * 1e6) / 1e6, accounting: options.mode === 'mock' ? 'mock' : aggregate.reported >= attempts && attempts > 0 ? 'sdk_estimate' : 'unreported', aggregateTokens: aggregate.tokens
  };
  const checks = evaluateCase(dataset, evalCase, world, observation);
  const summary = summarizeChecks(checks);
  const cited = observation.analysis ? observation.analysis.articles.map(a => a.articleId) : observation.read.map(r => r.articleId).filter(id => finalText.includes(id));
  return { observation, report: { caseId: evalCase.id, title: evalCase.title, traps: evalCase.traps, kind: evalCase.kind, status, failureCode, attempts, latencyMs: Math.round(latencyMs), costUsd: observation.costUsd,
    accounting: observation.accounting, aggregateTokens: observation.aggregateTokens, toolCalls: observation.toolCalls, cited, checks, ...summary, output: finalText.slice(0, 16000) } };
}
