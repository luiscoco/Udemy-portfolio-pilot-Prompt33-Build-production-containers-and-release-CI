import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { MetricReader } from '@opentelemetry/sdk-metrics';
import { actorRef, activeTraceparent, tracer, createLogger, initTelemetry, inSpan, JsonLinesSpanExporter, labelValue, metric, readTraceDirectory, resetActorKey, resetTelemetryForTests, safeAttributes, safeLabels, startSpan, traceTree } from './index.js';

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const spans = new InMemorySpanExporter();
const reader = new TestReader();

beforeAll(() => { resetTelemetryForTests(); initTelemetry({ serviceName: 'test-service', spanExporter: spans, metricReader: reader }); });
afterAll(() => resetTelemetryForTests());

describe('trace propagation across durable hops', () => {
  it('a stored traceparent continues the same trace as a child span in another process', async () => {
    spans.reset();
    let stored: string | null = null;
    await inSpan('ingestion.article', { 'pp.article.id': 'article-1' }, () => { stored = activeTraceparent(); });
    expect(stored).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    // Later, possibly in a different process, from the value read back from PostgreSQL or Redis:
    await inSpan('outbox.dispatch', { 'pp.event.id': 'e-1' }, () => inSpan('sse.send', {}, () => undefined), { parent: stored });
    const [ingest, send, dispatch] = spans.getFinishedSpans();
    expect(new Set([ingest!.spanContext().traceId, dispatch!.spanContext().traceId, send!.spanContext().traceId]).size).toBe(1);
    expect(dispatch!.parentSpanContext?.spanId).toBe(ingest!.spanContext().spanId);
    expect(send!.parentSpanContext?.spanId).toBe(dispatch!.spanContext().spanId);
  });

  it('parent: null starts a new root and links record related work without joining it', async () => {
    spans.reset();
    const outer = startSpan('poll');
    const link = activeTraceparent(outer.context);
    await inSpan('job', {}, () => undefined, { parent: null, links: [link, 'garbage'] });
    outer.span.end();
    const job = spans.getFinishedSpans().find(s => s.name === 'job')!;
    expect(job.parentSpanContext).toBeUndefined();
    expect(job.links).toHaveLength(1);
    expect(job.spanContext().traceId).not.toBe(outer.span.spanContext().traceId);
  });

  it('records failures with an error class, never the message', async () => {
    spans.reset();
    await expect(inSpan('fails', {}, () => { throw new TypeError('postgres://user:secret@host/db'); })).rejects.toThrow();
    const failed = spans.getFinishedSpans()[0]!;
    expect(failed.status.code).toBe(2);
    expect(failed.attributes['error.type']).toBe('TypeError');
    expect(JSON.stringify(failed.attributes)).not.toContain('secret');
    expect(failed.events).toHaveLength(0);
  });
});

describe('attribute and label safety', () => {
  it('keeps correlation IDs and drops content, money, URLs and user IDs from span attributes', () => {
    expect(safeAttributes({ 'pp.run.id': 'run-1', 'pp.actor': 'act_0123456789abcdef', 'pp.tool': 'getNewsArticle', 'pp.job.attempt': 2,
      'pp.prompt': 'secret question', 'pp.answer': 'x', 'pp.user_id': 'demo-alice', 'pp.price': '125.00', 'pp.quantity': 3, 'pp.article.url': 'https://example.invalid',
      'pp.source': 'https://example.invalid/a', 'pp.note': 'free text with spaces', 'custom.key': 'x', 'pp.usage.cost_usd': 0.01 }))
      .toEqual({ 'pp.run.id': 'run-1', 'pp.actor': 'act_0123456789abcdef', 'pp.tool': 'getNewsArticle', 'pp.job.attempt': 2, 'pp.usage.cost_usd': 0.01 });
  });
  it('refuses non-allowlisted metric labels and collapses identifier-like values', () => {
    expect(() => safeLabels({ userId: 'demo-alice' } as never)).toThrow(/not allowlisted/);
    expect(safeLabels({ outcome: 'completed', kind: 'news_analysis' })).toEqual({ outcome: 'completed', kind: 'news_analysis' });
    expect(safeLabels({ tool: 'searchNews' })).toEqual({ tool: 'searchNews' });
    expect(safeLabels({ tool: 'NOVA' })).toEqual({ tool: 'other' });
    for (const value of ['8f14e45f-ceea-467f-a7e4-1234567890ab', 'act_0123456789abcdef0123', 'NOVA', '125.50', 'alice@example.com', 'has space', 'ckz3x0abcdefghijklmnopqrst'])
      expect(labelValue(value)).toBe('other');
  });
  it('derives a stable keyed pseudonym that is not the user ID and differs per key', () => {
    resetActorKey();
    const env = { AUTH_SECRET: 'a'.repeat(40) };
    const first = actorRef('demo-alice', env);
    expect(first).toMatch(/^act_[0-9a-f]{16}$/);
    expect(actorRef('demo-alice', env)).toBe(first);
    expect(actorRef('demo-bob', env)).not.toBe(first);
    resetActorKey();
    expect(actorRef('demo-alice', { AUTH_SECRET: 'b'.repeat(40) })).not.toBe(first);
    resetActorKey();
  });
});

describe('exporter sanitization (third-party spans)', () => {
  it('drops URL/query/SQL/user attributes, exception events and status messages from spans created by libraries', () => {
    spans.reset();
    const span = tracer().startSpan('GET /api/events', { attributes: { 'http.target': '/api/events?cursor=s1.secret', 'http.route': '/api/events', 'next.span_name': 'GET /api/events',
      'url.full': 'https://app.example/api/events?cursor=x', 'db.statement': 'SELECT * FROM "User" WHERE email=$1', 'enduser.id': 'demo-alice', 'pp.run.id': 'run-1', 'http.method': 'GET' } });
    span.recordException(new Error('postgres://user:pw@db failed'));
    span.setStatus({ code: 2, message: 'raw error with demo-alice' });
    span.end();
    const exported = spans.getFinishedSpans()[0]!;
    expect(exported.attributes).toEqual({ 'http.route': '/api/events', 'next.span_name': 'GET /api/events', 'pp.run.id': 'run-1', 'http.method': 'GET' });
    expect(exported.events).toEqual([]);
    expect(exported.status).toEqual({ code: 2 });
    expect(exported.spanContext().spanId).toBe(span.spanContext().spanId);
    expect(exported.name).toBe('GET /api/events');
  });
});

describe('structured redacted logging', () => {
  it('writes one JSON object with trace correlation and redacted fields', async () => {
    const lines: string[] = [];
    const log = createLogger('test-service', { sink: line => lines.push(line) });
    await inSpan('request', {}, () => log.info('agent.run.finished', { runId: 'r1', actor: 'act_0123456789abcdef', prompt: 'my holdings', databaseUrl: 'postgres://u:p@h/d', note: 'see https://x.invalid?token=1' }));
    log.error('outbox.failed', { eventId: 'e1' }, new RangeError('Bearer abc.def'));
    const first = JSON.parse(lines[0]!), second = JSON.parse(lines[1]!);
    expect(first).toMatchObject({ level: 'info', event: 'agent.run.finished', service: 'test-service', runId: 'r1', prompt: '[REDACTED]', databaseUrl: '[REDACTED]', note: 'see [URL REDACTED]' });
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatchObject({ level: 'error', errorType: 'RangeError' });
    expect(lines.join('')).not.toMatch(/abc\.def|u:p@|my holdings/);
  });
});

describe('metrics', () => {
  it('exports the documented instruments with safe labels only', async () => {
    metric.runDuration(1.5, { kind: 'answer', outcome: 'completed', mode: 'mock' });
    metric.queueAge(0.2, { queue: 'agent_job', event_type: 'agent' });
    metric.sseConnection(1); metric.sseConnection(1); metric.sseConnection(-1);
    metric.replayReset('trimmed');
    metric.error('outbox', 'publish_failed');
    metric.usage(1200, 0.0042, { mode: 'claude', accounting: 'sdk_estimate' });
    metric.ingestionLag(-1, { data_mode: 'mock' }); // ignored: negative
    const { resourceMetrics } = await reader.collect();
    const points = new Map<string, { attributes: Record<string, unknown>; value: unknown }[]>();
    for (const scope of resourceMetrics.scopeMetrics) for (const m of scope.metrics) points.set(m.descriptor.name, m.dataPoints.map(p => ({ attributes: p.attributes, value: p.value })));
    expect(points.get('pp.sse.connections.active')![0]!.value).toBe(1);
    expect(points.get('pp.sse.replay.resets')![0]).toMatchObject({ attributes: { reason: 'trimmed' }, value: 1 });
    expect(points.get('pp.agent.usage.cost')![0]!.value).toBeCloseTo(0.0042);
    expect(points.get('pp.agent.run.duration')![0]!.attributes).toEqual({ kind: 'answer', outcome: 'completed', mode: 'mock' });
    expect(points.get('pp.ingestion.lag') ?? []).toHaveLength(0);
  });
});

describe('local trace files', () => {
  it('writes JSON lines per process and renders one trace as a tree', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pp-trace-'));
    const exporter = new JsonLinesSpanExporter(directory, 'test-service');
    spans.reset();
    await inSpan('root', { 'pp.run.id': 'r1' }, () => inSpan('child', {}, () => undefined));
    await new Promise<void>(resolve => exporter.export(spans.getFinishedSpans(), () => resolve()));
    const records = readTraceDirectory(directory);
    expect(records).toHaveLength(2);
    const tree = traceTree(records, records[0]!.traceId);
    expect(tree.split('\n')).toEqual([expect.stringMatching(/^root \[test-service\] .*pp\.run\.id=r1$/), expect.stringMatching(/^ {2}child \[test-service\]/)]);
  });
});
