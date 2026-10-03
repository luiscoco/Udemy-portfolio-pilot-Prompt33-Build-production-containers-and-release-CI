import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { exportableAttributes } from './attributes.js';

/**
 * Last line of defence before spans leave the process (file, console, OTLP). Our own helpers already
 * filter attributes, but libraries create spans directly: this wrapper re-applies the allowlist to every
 * span, drops span events (exception events carry messages and stacks) and the status message, and
 * keeps everything else (IDs, timing, links, parentage) unchanged.
 */
export class SanitizingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans.map(span => Object.create(span, {
      attributes: { value: exportableAttributes(span.attributes), enumerable: true },
      events: { value: [], enumerable: true },
      status: { value: { code: span.status.code }, enumerable: true }
    }) as ReadableSpan), done);
  }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
  forceFlush(): Promise<void> { return this.inner.forceFlush?.() ?? Promise.resolve(); }
}
