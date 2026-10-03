import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { closeConnections, getDatabase } from '@portfolio-pilot/db';
import { isExportableAttribute, readTraceDirectory, traceTree, type SpanRecord } from '@portfolio-pilot/observability';
import { fixtureArticle } from '../../worker/dist/fixture.js';
import { e2eDatabaseUrl, isDisposableDatabase } from './support/env';

// Milestone 32 acceptance: one article traced from ingestion to the browser, and one question traced
// from the API through the agent worker to its final message in the browser. Every process of the
// `observability` phase exports spans to JSON-lines files (OTEL_TRACES_EXPORTER=file); the browser side
// is observed by wrapping EventSource listeners, so the event ID the page received can be matched to
// the API's `sse.send` span. Nothing here dispatches or runs work itself: the harness's workers do.
const exec = promisify(execFile);
const url = e2eDatabaseUrl('OBSERVABILITY_E2E_DATABASE_URL');
const traceDir = process.env.PORTFOLIO_PILOT_TRACE_DIR;
const injector = fileURLToPath(new URL('../../worker/dist/inject-fixture.js', import.meta.url));
type Received = { type: string; id: string | null; data: Record<string, unknown> };

async function recordEvents(page: Page) {
  await page.addInitScript(() => {
    const received: unknown[] = [];
    (window as unknown as { __ppReceived: unknown[] }).__ppReceived = received;
    const original = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (this: EventSource, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      const wrapped = (event: Event) => {
        const message = event as MessageEvent<string>;
        try { const data = JSON.parse(message.data); received.push({ type, id: data?.id ?? null, data }); } catch { /* heartbeat/cursor frames */ }
        return typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
      };
      return original.call(this, type, wrapped as EventListener, options);
    } as typeof EventSource.prototype.addEventListener;
  });
}
const received = (page: Page) => page.evaluate(() => (window as unknown as { __ppReceived: Received[] }).__ppReceived);

/** Polls the span files until `find` succeeds (spans are written synchronously, files by several processes). */
async function spansUntil<T>(find: (spans: SpanRecord[]) => T | null, timeout = 30000): Promise<{ value: T; spans: SpanRecord[] }> {
  let last: SpanRecord[] = [];
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise(r => setTimeout(r, 250))) {
    last = readTraceDirectory(traceDir!);
    const value = find(last);
    if (value !== null) return { value, spans: last };
  }
  throw new Error(`Expected spans not found in ${traceDir} (${last.length} spans read).`);
}
const parentOf = (spans: SpanRecord[], span: SpanRecord) => spans.find(s => s.spanId === span.parentSpanId && s.traceId === span.traceId);
/** Exported telemetry carries IDs, enums and route templates only: no user ID, money, text or URLs with queries. */
function assertSafe(spans: SpanRecord[]) {
  const serialized = JSON.stringify(spans);
  expect(serialized).not.toContain('demo-alice');
  expect(serialized).not.toMatch(/cursor=|https?:\/\/|"pp\.(price|quantity|amount|prompt|content|title|summary|url)"/);
  for (const span of spans) for (const [key, value] of Object.entries(span.attributes)) expect({ key, exportable: isExportableAttribute(key, value) }).toEqual({ key, exportable: true });
}
test.describe('end-to-end tracing (milestone 32)', () => {
  test.skip(!url || !traceDir, 'Run through `npm run test:browser -- observability` (needs the file trace exporter on every process).');
  test.afterAll(async () => { await closeConnections(); });

  test('one article: ingestion -> outbox fan-out -> owner delivery -> SSE send -> received and shown in the browser', async ({ page }) => {
    test.setTimeout(120000);
    if (!isDisposableDatabase(url!)) throw new Error('Disposable loopback test database required.');
    const db = await getDatabase(url!);
    const run = `e2e-trace-${crypto.randomUUID().slice(0, 8)}`;
    await recordEvents(page);
    await page.goto('/news'); await page.getByRole('button', { name: 'Sign in as Alice Demo' }).click();
    await expect(page.getByLabel('Update connection')).toContainText('Live');

    await exec(process.execPath, [injector, run, '1'], { env: { ...process.env, NODE_ENV: 'development', DATA_MODE: 'mock', DATABASE_URL: url! } });
    const { articleId } = await db.newsSource.findUniqueOrThrow({ where: { provider_recordId: { provider: 'development-fixture', recordId: run } } });

    // The browser received the owner notification for exactly this article, and shows it.
    await expect.poll(async () => (await received(page)).find(e => e.type === 'news.available' && e.data.articleId === articleId)?.id ?? null, { timeout: 45000 }).not.toBeNull();
    const browserEvent = (await received(page)).find(e => e.type === 'news.available' && e.data.articleId === articleId)!;
    const title = fixtureArticle(run, 1, new Date().toISOString()).title;
    const updates = page.getByRole('button', { name: 'Show updates' });
    if (await updates.isVisible()) await updates.click();
    await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(1);

    // The SAME trace links every hop, across three processes.
    const { value: send, spans } = await spansUntil(all => all.find(s => s.name === 'sse.send' && s.attributes['pp.sse.event_id'] === browserEvent.id) ?? null);
    const trace = spans.filter(s => s.traceId === send.traceId);
    const ingest = trace.find(s => s.name === 'ingestion.article' && s.attributes['pp.article.id'] === articleId);
    const fanOut = trace.find(s => s.name === 'outbox.dispatch' && s.attributes['pp.event.type'] === 'news.article.ingested');
    const delivery = trace.find(s => s.name === 'outbox.dispatch' && s.attributes['pp.event.type'] === 'news.available' && s.attributes['pp.event.id'] === browserEvent.id);
    expect(ingest?.service).toBe('portfolio-pilot-ingestion-fixture');
    expect(fanOut?.service).toBe('portfolio-pilot-worker-outbox');
    expect(fanOut?.parentSpanId).toBe(ingest!.spanId);
    expect(delivery?.parentSpanId).toBe(fanOut!.spanId);
    expect(send.service).toBe('portfolio-pilot-api');
    expect(send.parentSpanId).toBe(delivery!.spanId);
    expect(send.attributes['pp.delivered']).toBe(true);
    expect(send.attributes['pp.actor']).toMatch(/^act_[0-9a-f]{16}$/);
    expect(trace.some(s => s.name === 'research.process_news')).toBe(true);
    assertSafe(trace);
    console.log(`article ${articleId} trace ${send.traceId}\n${traceTree(spans, send.traceId)}`);
  });

  test('one question: API request -> queued job -> agent worker and tools -> final message persisted -> SSE -> rendered', async ({ page }) => {
    test.setTimeout(120000);
    await recordEvents(page);
    await page.goto('/assistant'); await page.getByRole('button', { name: 'Sign in as Alice Demo' }).click();
    // A single-portfolio scope (seed "Growth"), so the mock agent reads holdings and news with tools.
    await page.getByLabel('Scope for new conversation').selectOption('demo-growth');
    const createdConversation = page.waitForResponse(r => r.url().endsWith('/api/conversations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    const conversationId = (await (await createdConversation).json()).conversation.id as string;
    await expect(page.getByLabel('Conversation', { exact: true })).toHaveValue(conversationId);
    await page.getByLabel('Ask about your portfolio').fill('What recent news is there about my holdings?');
    const createdRun = page.waitForResponse(r => /\/runs$/.test(r.url()) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const response = await createdRun;
    expect(response.status()).toBe(202);
    const requestId = response.headers()['x-request-id'];
    const { run } = await response.json() as { run: { id: string; assistantMessageId: string } };
    await expect(page.getByLabel('Conversation messages').locator(`[data-message-id="${run.assistantMessageId}"]`)).toHaveCount(1, { timeout: 45000 });
    await expect.poll(async () => (await received(page)).find(e => e.type === 'agent.message.completed' && e.data.runId === run.id)?.id ?? null, { timeout: 30000 }).not.toBeNull();
    const finalEvent = (await received(page)).find(e => e.type === 'agent.message.completed' && e.data.runId === run.id)!;

    const { value: send, spans } = await spansUntil(all => all.find(s => s.name === 'sse.send' && s.attributes['pp.sse.event_id'] === finalEvent.id) ?? null);
    const trace = spans.filter(s => s.traceId === send.traceId);
    const request = trace.find(s => s.name === 'api.request' && s.attributes['pp.request.id'] === requestId);
    const create = trace.find(s => s.name === 'chat.run.create' && s.attributes['pp.run.id'] === run.id);
    const agentRun = trace.find(s => s.name === 'agent.run' && s.attributes['pp.run.id'] === run.id);
    const tools = trace.filter(s => s.name === 'agent.tool');
    const persist = trace.find(s => s.name === 'agent.message.persist');
    const dispatch = trace.find(s => s.name === 'outbox.dispatch' && s.attributes['pp.event.id'] === finalEvent.id);
    expect(request?.service).toBe('portfolio-pilot-api');
    expect(create?.parentSpanId).toBe(request!.spanId);
    expect(agentRun?.service).toBe('portfolio-pilot-worker-agent');
    expect(agentRun?.parentSpanId).toBe(create!.spanId);
    expect(agentRun?.attributes).toMatchObject({ 'pp.job.id': run.id, 'pp.outcome': 'completed', 'pp.mode': 'mock', 'pp.actor': create!.attributes['pp.actor'] });
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) { expect(tool.parentSpanId).toBe(agentRun!.spanId); expect(String(tool.attributes['pp.tool_call.id'])).toMatch(new RegExp(`^${run.assistantMessageId}\\.t\\d+$`)); }
    expect(parentOf(trace, persist!)?.spanId).toBe(agentRun!.spanId);
    expect(dispatch?.service).toBe('portfolio-pilot-worker-outbox');
    expect(dispatch?.parentSpanId).toBe(persist!.spanId);
    expect(send.parentSpanId).toBe(dispatch!.spanId);
    // Streamed progress shares the trace too (each text/tool event's dispatch descends from agent.run).
    expect(trace.filter(s => s.name === 'sse.send').length).toBeGreaterThan(1);
    assertSafe(trace);
    console.log(`run ${run.id} request ${requestId} trace ${send.traceId}\n${traceTree(spans, send.traceId)}`);
  });
});
