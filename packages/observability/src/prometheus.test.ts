import { afterAll, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { initTelemetry, metric, resetTelemetryForTests, type TelemetryHandle } from './index.js';

// Local inspection path: OTEL_METRICS_EXPORTER=prometheus serves a scrape endpoint on loopback.
const freePort = () => new Promise<number>(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }); });
let handle: TelemetryHandle | undefined;
afterAll(async () => { await handle?.shutdown(); resetTelemetryForTests(); });

it('serves every documented instrument with allowlisted labels only', async () => {
  resetTelemetryForTests();
  const port = await freePort();
  handle = initTelemetry({ serviceName: 'metrics-smoke', env: { OTEL_METRICS_EXPORTER: 'prometheus', OTEL_EXPORTER_PROMETHEUS_PORT: String(port) } });
  metric.ingestionLag(42, { data_mode: 'mock' });
  metric.queueAge(0.3, { queue: 'outbox', event_type: 'news.available' });
  metric.runDuration(2.5, { kind: 'answer', outcome: 'completed', mode: 'mock' });
  metric.sseConnection(1);
  metric.replayReset('snapshot_required');
  metric.error('outbox', 'dispatch_failed');
  metric.usage(1500, 0.02, { mode: 'claude', accounting: 'sdk_estimate' });
  metric.toolCall('searchNews', 'succeeded');
  metric.outboxDispatched('published', 'agent.text.delta');
  let body = '';
  for (let i = 0; i < 40 && !body.includes('pp_outbox_dispatched'); i++) {
    try { body = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text(); } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  for (const name of ['pp_ingestion_lag', 'pp_queue_age', 'pp_agent_run_duration', 'pp_sse_connections_active', 'pp_sse_replay_resets', 'pp_errors', 'pp_agent_usage_tokens', 'pp_agent_usage_cost', 'pp_agent_tool_calls', 'pp_outbox_dispatched'])
    expect(body).toContain(name);
  expect(body).toMatch(/^pp_sse_replay_resets_total\{reason="snapshot_required",otel_scope_name="portfolio-pilot"\} 1$/m);
  expect(body).toMatch(/^pp_agent_tool_calls_total\{tool="searchNews",status="succeeded",/m);
  // Every label key in our series is allowlisted.
  const keys = new Set([...body.matchAll(/^pp_[a-z_]+\{([^}]*)\}/gm)].flatMap(m => [...m[1]!.matchAll(/([a-z_]+)="/g)].map(k => k[1]!)));
  for (const key of keys) expect(['component', 'outcome', 'mode', 'queue', 'reason', 'kind', 'tool', 'status', 'code', 'role', 'data_mode', 'accounting', 'event_type', 'le', 'otel_scope_name', 'otel_scope_version', 'otel_scope_schema_url']).toContain(key);
  console.log(body.split('\n').filter(line => line.startsWith('pp_') && !line.includes('_bucket')).join('\n'));
});
