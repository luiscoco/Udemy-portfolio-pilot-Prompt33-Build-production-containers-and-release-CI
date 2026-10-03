import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { calculatePortfolioSummary, type ValuationQuote, type ValuationTrade } from '@portfolio-pilot/domain';
import type { NewsDetail, NewsFeedItem, PortfolioSummary } from '@portfolio-pilot/contracts';
import type { PortfolioToolData } from '../tools/context.js';

/**
 * Versioned evaluation dataset (milestone 32). A case is a self-contained, owner-bound world: the
 * holdings, quotes and articles the tools may return, plus what a correct response must and must not
 * do. Change cases only with a new `datasetVersion`, so results stay comparable across runs.
 */
export const TRAP_KINDS = ['missing_quote', 'stale_news', 'contradictory_sources', 'irrelevant_articles', 'prompt_injection', 'privacy'] as const;
export const UNCERTAINTY_TOPICS = ['missing_quote', 'stale_news', 'contradiction', 'not_found'] as const;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const holding = z.object({ securityId: id, quantity: z.string(), price: z.string(), fees: z.string() }).strict();
const quote = z.object({ securityId: id, price: z.string(), minutesAgo: z.number().int().nonnegative() }).strict();
const article = z.object({ id, title: z.string().min(1).max(300), summary: z.string().min(1).max(2000), source: z.string(), minutesAgo: z.number().int().nonnegative(),
  securities: z.array(id), delayed: z.boolean().optional() }).strict();
const budget = z.object({ latencyMs: z.number().int().positive(), costUsd: z.number().nonnegative() }).strict();
const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,48}$/), title: z.string(), traps: z.array(z.enum(TRAP_KINDS)), kind: z.enum(['news_analysis', 'answer']), question: z.string().min(1).max(500),
  holdings: z.array(holding).optional(), watchlist: z.array(id).optional(), quotes: z.array(quote).optional(), articles: z.array(article).max(20),
  expected: z.object({
    requiredEvidence: z.array(id), forbiddenEvidence: z.array(id), staleEvidence: z.array(id).default([]), affectedHoldings: z.array(z.string()),
    requiredUncertainty: z.array(z.enum(UNCERTAINTY_TOPICS)), requiredTools: z.array(z.string()), forbiddenTools: z.array(z.string()),
    injectionCanaries: z.array(z.string()).default([]), groundedNumbers: z.boolean().default(false),
    /** Typed refusals that are a correct outcome for this case (e.g. no recent article: no analysis is better than an invented one). */
    acceptableFailures: z.array(z.string()).default([]),
    maxConfidence: z.enum(['low', 'medium']).optional(), maxToolCalls: z.number().int().positive().optional(),
    /** Human-readable statement of what interpretation is acceptable; the judge rubric reads it, deterministic checks do not. */
    permissibleInterpretations: z.string().min(1)
  }).strict()
}).strict();
export const datasetSchema = z.object({
  datasetId: z.string(), datasetVersion: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string(), now: z.iso.datetime(),
  owner: z.object({ userId: id, portfolioId: id, portfolioName: z.string() }).strict(),
  securities: z.array(z.object({ id, symbol: z.string(), exchangeMic: z.string(), name: z.string() }).strict()),
  defaults: z.object({ holdings: z.array(holding), watchlist: z.array(id), quotes: z.array(quote), forbiddenPhrases: z.array(z.string()),
    maxConfidence: z.enum(['low', 'medium']), budgets: z.object({ mock: budget, live: budget }).strict(), maxToolCalls: z.number().int().positive() }).strict(),
  foreign: z.object({ description: z.string(), portfolioIds: z.array(id), articleIds: z.array(id), canaries: z.array(z.string()),
    content: z.object({ title: z.string(), owner: z.string() }).strict() }).strict(),
  cases: z.array(caseSchema).min(1)
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const c of value.cases) { if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: `Duplicate case ${c.id}` }); ids.add(c.id); }
});
export type EvalDataset = z.infer<typeof datasetSchema>;
export type EvalCase = EvalDataset['cases'][number];

export const DEFAULT_DATASET = fileURLToPath(new URL('../../eval/datasets/portfolio-news-v1.json', import.meta.url));
export function loadDataset(path = DEFAULT_DATASET): EvalDataset {
  return datasetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const notFound = () => Object.assign(new Error('Resource not found.'), { status: 404 });
const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60000).toISOString();
export const articleUrl = (articleId: string) => `https://example.invalid/eval/${articleId}`;

/** The concrete world a case defines, in the same DTO shapes the repositories return. */
export function caseWorld(dataset: EvalDataset, evalCase: EvalCase) {
  const now = new Date(dataset.now);
  const security = (securityId: string) => dataset.securities.find(s => s.id === securityId) ?? (() => { throw new Error(`Unknown security ${securityId}`); })();
  const holdings = evalCase.holdings ?? dataset.defaults.holdings;
  const watchlist = new Set(evalCase.watchlist ?? dataset.defaults.watchlist);
  const trades: ValuationTrade[] = holdings.map((h, i) => ({ securityId: h.securityId, side: 'BUY', quantity: h.quantity, price: h.price, fees: h.fees, ledgerOrder: BigInt(i + 1),
    occurredAt: new Date(Date.UTC(2025, 0, 2) + i * 60000).toISOString() }));
  const quotes: ValuationQuote[] = (evalCase.quotes ?? dataset.defaults.quotes).map(q => ({ securityId: q.securityId, price: q.price, currency: 'USD', asOf: minutesBefore(now, q.minutesAgo), provider: 'eval-fixture', isSynthetic: true }));
  const calculated = calculatePortfolioSummary(trades, quotes, now.toISOString());
  const summary: PortfolioSummary = { ...calculated, portfolioId: dataset.owner.portfolioId, name: dataset.owner.portfolioName,
    positions: calculated.positions.map(p => ({ ...p, quoteStatus: p.quoteStatus as PortfolioSummary['positions'][number]['quoteStatus'], security: { symbol: security(p.securityId).symbol, exchangeMic: security(p.securityId).exchangeMic, currency: 'USD' as const } })) };
  const held = new Set(holdings.map(h => h.securityId));
  const articles: NewsFeedItem[] = evalCase.articles.map(a => {
    const publishedAt = minutesBefore(now, a.minutesAgo);
    return { id: a.id, provider: 'eval-fixture', source: a.source, title: a.title, summary: a.summary, url: articleUrl(a.id), publishedAt, updatedAt: publishedAt,
      ingestedAt: minutesBefore(now, Math.max(0, a.minutesAgo - 1)), providerAt: publishedAt, revision: 1, isDelayed: a.delayed ?? false, delayMs: 0, isSynthetic: true,
      readAt: null, readRevisionAt: null, securities: a.securities.map(s => ({ id: s, symbol: security(s).symbol, exchangeMic: security(s).exchangeMic })) };
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { now, summary, held, watchlist, articles, quotes, security };
}
export type CaseWorld = ReturnType<typeof caseWorld>;

/**
 * In-memory owner-bound data port with repository semantics: only this owner's portfolio, only
 * securities of interest, and "not found" (404) for anything else, including the foreign IDs.
 */
export function fixturePort(dataset: EvalDataset, world: CaseWorld): PortfolioToolData & { reads: string[] } {
  const reads: string[] = [];
  const portfolio = (portfolioId: string) => { if (portfolioId !== dataset.owner.portfolioId) throw notFound(); return world.summary; };
  const interest = (securityIds: string[]) => securityIds.some(s => world.held.has(s) || world.watchlist.has(s));
  return {
    reads,
    async listPortfolios(take) { reads.push('listPortfolios'); return [{ id: dataset.owner.portfolioId, name: dataset.owner.portfolioName, archivedAt: null }].slice(0, take); },
    async getSummary(portfolioId) { reads.push('getSummary'); return portfolio(portfolioId); },
    async listTransactions(portfolioId) { reads.push('listTransactions'); portfolio(portfolioId); return { transactions: [], nextOffset: null }; },
    async listSecurities(ids, take) {
      reads.push('listSecurities');
      return dataset.securities.filter(s => (world.held.has(s.id) || world.watchlist.has(s.id)) && (!ids || ids.includes(s.id))).slice(0, take)
        .map(s => ({ ...s, currency: 'USD', watchlisted: world.watchlist.has(s.id), traded: world.held.has(s.id) }));
    },
    async latestQuotes(ids) {
      reads.push('latestQuotes');
      const quotes = world.quotes.filter(q => ids.includes(q.securityId) && interest([q.securityId]));
      return { quotes, missing: ids.filter(i => !quotes.some(q => q.securityId === i)), servedAt: world.now.toISOString() };
    },
    async searchNews(input) {
      reads.push('searchNews');
      if (input.portfolioId) portfolio(input.portfolioId);
      const symbols = new Set(input.symbols ?? []);
      const text = input.query?.toLowerCase();
      const matches = world.articles.filter(a => interest(a.securities.map(s => s.id))
        && (!input.portfolioId || a.securities.some(s => world.held.has(s.id)))
        && (input.scope !== 'watchlist' || a.securities.some(s => world.watchlist.has(s.id)))
        && (!symbols.size || a.securities.some(s => symbols.has(s.symbol)))
        && (!text || `${a.title} ${a.summary}`.toLowerCase().includes(text)));
      const limit = input.limit ?? 10;
      return { portfolioId: input.portfolioId ?? null, generatedAt: world.now.toISOString(), articles: matches.slice(0, limit), nextCursor: null };
    },
    async getNewsArticle(articleId): Promise<NewsDetail> {
      reads.push('getNewsArticle');
      const found = world.articles.find(a => a.id === articleId);
      if (!found || !interest(found.securities.map(s => s.id))) throw notFound();
      const positions = world.summary.positions.filter(p => found.securities.some(s => s.id === p.securityId) && world.held.has(p.securityId));
      return { article: found, impacts: positions.length ? [{ portfolioId: world.summary.portfolioId, name: world.summary.name, asOf: world.summary.asOf, positions }] : [],
        watchlisted: found.securities.filter(s => world.watchlist.has(s.id)).map(s => s.id),
        provenance: [{ id: `${found.id}-o1`, source: found.source ?? 'eval', recordId: found.id, providerAt: found.publishedAt, observedAt: found.ingestedAt ?? found.publishedAt, revision: 1, title: found.title, url: found.url, accepted: true }] };
    }
  };
}
