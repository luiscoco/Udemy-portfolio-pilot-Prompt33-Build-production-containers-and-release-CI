import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

/** One finished span as written to a local JSON-lines trace file. */
export interface SpanRecord {
  traceId: string; spanId: string; parentSpanId: string | null; name: string; service: string;
  start: string; durationMs: number; status: 'unset' | 'ok' | 'error';
  attributes: Record<string, unknown>; links: Array<{ traceId: string; spanId: string }>;
}

export function toSpanRecord(span: ReadableSpan): SpanRecord {
  const context = span.spanContext();
  return {
    traceId: context.traceId, spanId: context.spanId, parentSpanId: span.parentSpanContext?.spanId ?? null, name: span.name,
    service: String(span.resource.attributes['service.name'] ?? 'unknown'),
    start: new Date(hrTimeToMilliseconds(span.startTime)).toISOString(), durationMs: Math.round(hrTimeToMilliseconds(span.duration) * 1000) / 1000,
    status: span.status.code === 2 ? 'error' : span.status.code === 1 ? 'ok' : 'unset',
    attributes: { ...span.attributes }, links: span.links.map(link => ({ traceId: link.context.traceId, spanId: link.context.spanId }))
  };
}

/**
 * Local inspection only: appends finished spans to `<dir>/<service>-<pid>.jsonl`, one file per
 * process so concurrent replicas never interleave partial lines. Attributes were already filtered by
 * `safeAttributes`, so the files hold IDs and enums, not portfolio data. Not for production.
 */
export class JsonLinesSpanExporter implements SpanExporter {
  private readonly file: string;
  constructor(directory: string, service: string) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, `${service.replace(/[^\w.-]/g, '_')}-${process.pid}.jsonl`);
  }
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    try {
      appendFileSync(this.file, spans.map(span => JSON.stringify(toSpanRecord(span))).join('\n') + '\n');
      done({ code: ExportResultCode.SUCCESS });
    } catch (error) { done({ code: ExportResultCode.FAILED, error: error as Error }); }
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}
