import { context, metrics as metricsApi, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context, type Link, type Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ConsoleSpanExporter, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, AlwaysOnSampler, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AggregationTemporalityPreference, OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { JsonLinesSpanExporter } from './file-exporter.js';
import { SanitizingSpanExporter } from './sanitizing-exporter.js';
import { safeAttributes } from './attributes.js';

export const TRACER_NAME = 'portfolio-pilot';
const propagator = new W3CTraceContextPropagator();
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export interface TelemetryOptions {
  /** `service.name`, e.g. portfolio-pilot-api or portfolio-pilot-worker-outbox. */
  serviceName: string;
  env?: NodeJS.ProcessEnv;
  /** Tests: capture spans/metrics in memory instead of reading exporter settings. */
  spanExporter?: SpanExporter;
  metricReader?: MetricReader;
}
export interface TelemetryHandle { enabled: boolean; traces: string[]; metrics: string[]; shutdown(): Promise<void>; flush(): Promise<void> }

const SLOT = Symbol.for('portfolio-pilot.telemetry');
type Global = typeof globalThis & { [SLOT]?: TelemetryHandle };
const list = (value: string | undefined, fallback: string) => (value ?? fallback).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/**
 * Starts tracing and metrics once per process from standard OpenTelemetry variables plus one local
 * option. Exporters are opt-in; the tracer provider itself is always registered (unless
 * OTEL_SDK_DISABLED=true) so trace context keeps flowing through PostgreSQL and Redis even when this
 * particular process exports nothing.
 *
 *   OTEL_TRACES_EXPORTER    none (default) | otlp | console | file   (comma-separated)
 *   OTEL_METRICS_EXPORTER   none (default) | otlp | prometheus | console
 *   PORTFOLIO_PILOT_TRACE_DIR  directory for `file` (JSON lines, local inspection only)
 *   OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS, OTEL_EXPORTER_PROMETHEUS_HOST / _PORT,
 *   OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE (delta for Azure Monitor), OTEL_TRACES_SAMPLER_ARG.
 */
export function initTelemetry(options: TelemetryOptions): TelemetryHandle {
  const state = globalThis as Global;
  if (state[SLOT]) return state[SLOT];
  const env = options.env ?? process.env;
  if (env.OTEL_SDK_DISABLED === 'true') {
    return (state[SLOT] = { enabled: false, traces: [], metrics: [], async shutdown() {}, async flush() {} });
  }
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName, [ATTR_SERVICE_VERSION]: '0.0.0',
    ...(env.INSTANCE_ID ? { 'service.instance.id': env.INSTANCE_ID } : {}), 'deployment.environment.name': env.NODE_ENV ?? 'development' });

  const traces = options.spanExporter ? ['test'] : list(env.OTEL_TRACES_EXPORTER, 'none').filter(name => name !== 'none');
  const processors: SpanProcessor[] = [];
  if (options.spanExporter) processors.push(new SimpleSpanProcessor(new SanitizingSpanExporter(options.spanExporter)));
  for (const name of traces) {
    if (name === 'otlp') processors.push(new BatchSpanProcessor(new SanitizingSpanExporter(new OTLPTraceExporter())));
    else if (name === 'console') processors.push(new SimpleSpanProcessor(new SanitizingSpanExporter(new ConsoleSpanExporter())));
    else if (name === 'file') {
      if (!env.PORTFOLIO_PILOT_TRACE_DIR) throw new Error('OTEL_TRACES_EXPORTER=file requires PORTFOLIO_PILOT_TRACE_DIR.');
      // Simple (synchronous) export so a test can read the span as soon as the operation returns.
      processors.push(new SimpleSpanProcessor(new SanitizingSpanExporter(new JsonLinesSpanExporter(env.PORTFOLIO_PILOT_TRACE_DIR, options.serviceName))));
    } else if (name !== 'test') throw new Error(`Unsupported OTEL_TRACES_EXPORTER "${name}".`);
  }
  const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG);
  const provider = new NodeTracerProvider({ resource, spanProcessors: processors,
    sampler: new ParentBasedSampler({ root: Number.isFinite(ratio) && ratio >= 0 && ratio < 1 ? new TraceIdRatioBasedSampler(ratio) : new AlwaysOnSampler() }),
    generalLimits: { attributeValueLengthLimit: 256, attributeCountLimit: 64 } });
  // Registers the AsyncLocalStorage context manager and the W3C trace-context propagator.
  provider.register({ propagator });

  const readers: MetricReader[] = [];
  const metrics = options.metricReader ? ['test'] : list(env.OTEL_METRICS_EXPORTER, 'none').filter(name => name !== 'none');
  if (options.metricReader) readers.push(options.metricReader);
  for (const name of metrics) {
    if (name === 'otlp') {
      const delta = (env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ?? '').toLowerCase() === 'delta';
      readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(delta ? { temporalityPreference: AggregationTemporalityPreference.DELTA } : {}), exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 60000 }));
    } else if (name === 'console') readers.push(new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter(), exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 60000 }));
    else if (name === 'prometheus') {
      // Loopback by default: the scrape endpoint shows operational aggregates, not public data.
      readers.push(new PrometheusExporter({ host: env.OTEL_EXPORTER_PROMETHEUS_HOST || '127.0.0.1', port: Number(env.OTEL_EXPORTER_PROMETHEUS_PORT) || 9464 }));
    } else if (name !== 'test') throw new Error(`Unsupported OTEL_METRICS_EXPORTER "${name}".`);
  }
  const meterProvider = new MeterProvider({ resource, readers });
  metricsApi.setGlobalMeterProvider(meterProvider);

  const handle: TelemetryHandle = {
    enabled: true, traces, metrics,
    async flush() { await Promise.allSettled([provider.forceFlush(), meterProvider.forceFlush()]); },
    async shutdown() { await Promise.allSettled([provider.shutdown(), meterProvider.shutdown()]); }
  };
  return (state[SLOT] = handle);
}

/** Test hook: forget the process-wide handle (the global OTel API registration stays). */
export function resetTelemetryForTests() {
  delete (globalThis as Global)[SLOT];
  trace.disable(); context.disable(); propagation.disable(); metricsApi.disable();
}

export const tracer = () => trace.getTracer(TRACER_NAME);

/** W3C `traceparent` of the active span, or null when no valid span is active. */
export function activeTraceparent(active: Context = context.active()): string | null {
  const carrier: Record<string, string> = {};
  propagator.inject(active, carrier, { set: (target, key, value) => { target[key] = value; } });
  const value = carrier.traceparent;
  return value && TRACEPARENT.test(value) && !value.startsWith('00-00000000000000000000000000000000') ? value : null;
}
/** Context carrying a remote parent from a stored/received `traceparent`; invalid input yields a new root. */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  if (!traceparent || !TRACEPARENT.test(traceparent)) return ROOT_CONTEXT;
  return propagator.extract(ROOT_CONTEXT, { traceparent }, { get: (carrier, key) => carrier[key as 'traceparent'], keys: carrier => Object.keys(carrier) });
}
export function linkFromTraceparent(traceparent: string | null | undefined): Link | null {
  const spanContext = trace.getSpanContext(contextFromTraceparent(traceparent));
  return spanContext ? { context: spanContext } : null;
}
/** Active trace/span IDs for log correlation. */
export function currentTraceIds(): { traceId: string; spanId: string } | null {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && spanContext.traceId !== '00000000000000000000000000000000' ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : null;
}

export interface SpanOptions {
  /**
   * Durable-hop parent. A string makes the new span a CHILD of that stored context (one trace from
   * ingestion to browser); null starts a new root even inside another span (e.g. a worker poll loop).
   * Undefined uses the active context.
   */
  parent?: string | null;
  /** Related contexts that are not the parent (e.g. a batch). */
  links?: Array<string | null | undefined>;
  kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
}
const KINDS = { internal: SpanKind.INTERNAL, server: SpanKind.SERVER, client: SpanKind.CLIENT, producer: SpanKind.PRODUCER, consumer: SpanKind.CONSUMER } as const;

/** Starts a span that the caller ends (for lifetimes that do not match one function call). */
export function startSpan(name: string, attributes?: Record<string, unknown>, options: SpanOptions = {}): { span: Span; context: Context } {
  const parent = options.parent === undefined ? context.active() : contextFromTraceparent(options.parent);
  const links = (options.links ?? []).map(linkFromTraceparent).filter((link): link is Link => link !== null);
  const span = tracer().startSpan(name, { kind: KINDS[options.kind ?? 'internal'], attributes: safeAttributes(attributes), links }, parent);
  return { span, context: trace.setSpan(parent, span) };
}

/** Marks a span failed with a bounded error class only; messages may contain data and are never recorded. */
export function recordFailure(span: Span, error: unknown, code?: string) {
  const type = code ?? (error instanceof Error && /^[A-Za-z]{1,48}$/.test(error.name) ? error.name : 'error');
  span.setAttribute('error.type', type);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Runs `work` inside a span that is active for all nested async work, and ends it afterwards. */
export async function inSpan<T>(name: string, attributes: Record<string, unknown> | undefined, work: (span: Span) => Promise<T> | T, options: SpanOptions = {}): Promise<T> {
  const { span, context: spanContext } = startSpan(name, attributes, options);
  try {
    return await context.with(spanContext, () => work(span));
  } catch (error) {
    recordFailure(span, error);
    throw error;
  } finally { span.end(); }
}
/** Adds filtered attributes to a span (or the active span). */
export function annotate(attributes: Record<string, unknown>, span: Span | undefined = trace.getActiveSpan()) {
  span?.setAttributes(safeAttributes(attributes));
}
