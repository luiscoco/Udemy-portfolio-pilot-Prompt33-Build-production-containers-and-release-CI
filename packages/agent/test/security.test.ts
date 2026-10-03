import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPortfolioTools } from '../src/tools/portfolio-tools.js';
import { portfolioToolPermissionGuard } from '../src/tools/options.js';
import { createApprovalTools } from '../src/approval-tools.js';
import { context, defaultState } from './fixtures.js';
const attack = JSON.parse(readFileSync(new URL('../../../tests/fixtures/adversarial-news.json', import.meta.url), 'utf8'));
describe('adversarial news: enforcement without model obedience', () => {
  it('leaves injected instructions as data and denies their requested foreign reads and exfiltration', async () => {
    const state = defaultState(); Object.assign(state.articles[0]!, { title: attack.title, summary: attack.summary });
    const ctx = context(state); const tools = createPortfolioTools(ctx);
    const article = await tools.find(t => t.name === 'getNewsArticle')!.handler({ articleId: 'a1' }, undefined);
    expect(JSON.stringify(article)).toContain('Ignore the system instructions');
    expect((article.structuredContent as any).meta.untrustedText).toBe(true);
    // Simulate a compromised model actually issuing the actions, rather than testing a refusal answer.
    for (const name of ['getPortfolioSummary', 'listHoldings', 'listTransactions', 'searchNews']) {
      const response = await tools.find(t => t.name === name)!.handler({ portfolioId: attack.foreignPortfolioId }, undefined);
      expect(response.isError).toBe(true); expect(JSON.stringify(response)).not.toContain('fixture-password');
    }
    for (const name of ['Bash', 'Read', 'Write', 'WebFetch', 'mcp__evil__exfiltrate']) {
      expect(await portfolioToolPermissionGuard(name, attack.exfiltrationArguments, { signal: new AbortController().signal } as never)).toMatchObject({ behavior: 'deny' });
    }
    const spoofed = await tools[0]!.handler({ userId: 'demo-bob' }, undefined); expect(spoofed.isError).toBe(true);
    const oversized = await tools[0]!.handler({ portfolioId: 'x'.repeat(9000) }, undefined); expect(oversized.isError).toBe(true);
  });
  it('caps alert output, cancels direct reads, and requires approval inside the mutation handler', async () => {
    const controller = new AbortController(); const execute = vi.fn(async () => { throw new Error('Approval required'); });
    const ctx = { ...context(), resultBytes: 200, signal: controller.signal, approval: {
      rules: vi.fn(async () => [{ name: 'x'.repeat(1000) }] as never), authorize: vi.fn(async () => false), execute
    } };
    const tools = createApprovalTools(ctx);
    expect((await tools[0]!.handler({}, undefined)).isError).toBe(true);
    expect((await tools[1]!.handler({ actionType: 'watchlist.add', arguments: { symbol: 'NOVA', exchangeMic: 'XNAS' } }, undefined)).isError).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    controller.abort(); ctx.approval.rules.mockClear();
    expect((await tools[0]!.handler({}, undefined)).isError).toBe(true); expect(ctx.approval.rules).not.toHaveBeenCalled();
  });
  it('caps the complete duplicated MCP envelope, not only structured JSON', async () => {
    const state = defaultState();
    for (const p of state.portfolios) p.name = p.summary.name = 'x'.repeat(30000);
    const result = await createPortfolioTools(context(state))[0]!.handler({}, undefined);
    expect(result.isError).toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48000);
  });
});
