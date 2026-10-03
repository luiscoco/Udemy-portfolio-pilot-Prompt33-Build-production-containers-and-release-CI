import { metrics, type Counter, type Histogram, type MeterProvider, type UpDownCounter } from '@opentelemetry/api';
import { safeLabels, type MetricLabels } from './attributes.js';

/**
 * Operational metrics (milestone 32). Every instrument is described here once, with its unit and the
 * ONLY labels it may carry. Labels pass `safeLabels`: allowlisted keys, enum-like values. User IDs,
 * actor pseudonyms, run/article IDs, symbols, prices and amounts are never labels.
 */
const SECONDS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 3600];
type Instruments = {
  ingestionLag: Histogram; queueAge: Histogram; runDuration: Histogram; sseActive: UpDownCounter; replayResets: Counter;
  errors: Counter; usageTokens: Counter; usageCost: Counter; toolCalls: Counter; outboxDispatched: Counter;
};
let cache: { provider: MeterProvider; instruments: Instruments } | null = null;

function instruments(): Instruments {
  // Instruments from the no-op provider stay no-op, so they are rebuilt once a real provider registers.
  const provider = metrics.getMeterProvider();
  if (cache?.provider === provider) return cache.instruments;
  const meter = provider.getMeter('portfolio-pilot');
  const seconds = (name: string, description: string) => meter.createHistogram(name, { unit: 's', description, advice: { explicitBucketBoundaries: SECONDS_BUCKETS } });
  const created: Instruments = {
    ingestionLag: seconds('pp.ingestion.lag', 'Article publication to durable ingestion commit. Labels: data_mode.'),
    queueAge: seconds('pp.queue.age', 'Time a durable work item waited before a worker picked it up. Labels: queue (outbox|agent_job), event_type.'),
    runDuration: seconds('pp.agent.run.duration', 'Agent run wall time from claim to persisted outcome. Labels: kind, outcome, mode.'),
    sseActive: meter.createUpDownCounter('pp.sse.connections.active', { unit: '{connection}', description: 'Open authenticated SSE streams on this API replica.' }),
    replayResets: meter.createCounter('pp.sse.replay.resets', { unit: '{reset}', description: 'Streams told to recover from a snapshot. Labels: reason.' }),
    errors: meter.createCounter('pp.errors', { unit: '{error}', description: 'Handled failures by component and bounded code. Labels: component, code.' }),
    usageTokens: meter.createCounter('pp.agent.usage.tokens', { unit: '{token}', description: 'Observed (SDK-reported) agent tokens. Labels: mode, accounting.' }),
    usageCost: meter.createCounter('pp.agent.usage.cost', { unit: 'USD', description: 'SDK-estimated agent cost; an estimate, not a bill. Labels: mode, accounting.' }),
    toolCalls: meter.createCounter('pp.agent.tool.calls', { unit: '{call}', description: 'Agent tool calls by public tool name and terminal status. Labels: tool, status.' }),
    outboxDispatched: meter.createCounter('pp.outbox.dispatched', { unit: '{event}', description: 'Outbox dispatch outcomes. Labels: outcome, event_type.' })
  };
  cache = { provider, instruments: created };
  return created;
}

const nonNegative = (value: number) => Number.isFinite(value) && value >= 0;
export const metric = {
  ingestionLag(seconds: number, labels: Pick<MetricLabels, 'data_mode'>) { if (nonNegative(seconds)) instruments().ingestionLag.record(seconds, safeLabels(labels)); },
  queueAge(seconds: number, labels: Pick<MetricLabels, 'queue' | 'event_type'>) { if (nonNegative(seconds)) instruments().queueAge.record(seconds, safeLabels(labels)); },
  runDuration(seconds: number, labels: Pick<MetricLabels, 'kind' | 'outcome' | 'mode'>) { if (nonNegative(seconds)) instruments().runDuration.record(seconds, safeLabels(labels)); },
  sseConnection(delta: 1 | -1) { instruments().sseActive.add(delta); },
  replayReset(reason: string) { instruments().replayResets.add(1, safeLabels({ reason })); },
  error(component: string, code: string) { instruments().errors.add(1, safeLabels({ component, code })); },
  usage(tokens: number, costUsd: number, labels: Pick<MetricLabels, 'mode' | 'accounting'>) {
    if (nonNegative(tokens) && tokens > 0) instruments().usageTokens.add(tokens, safeLabels(labels));
    if (nonNegative(costUsd) && costUsd > 0) instruments().usageCost.add(costUsd, safeLabels(labels));
  },
  toolCall(tool: string, status: string) { instruments().toolCalls.add(1, safeLabels({ tool, status })); },
  outboxDispatched(outcome: string, eventType: string) { instruments().outboxDispatched.add(1, safeLabels({ outcome, event_type: eventType })); }
};
