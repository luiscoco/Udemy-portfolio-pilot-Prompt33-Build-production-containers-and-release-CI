import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpanRecord } from './file-exporter.js';

/** Reads every `*.jsonl` span file a local run wrote (one per process). Malformed lines are skipped. */
export function readTraceDirectory(directory: string): SpanRecord[] {
  const spans: SpanRecord[] = [];
  let files: string[] = [];
  try { files = readdirSync(directory).filter(name => name.endsWith('.jsonl')); } catch { return spans; }
  for (const file of files) for (const line of readFileSync(join(directory, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { spans.push(JSON.parse(line) as SpanRecord); } catch { /* a line being written concurrently */ }
  }
  return spans.sort((a, b) => a.start.localeCompare(b.start));
}

/** Indented text tree of one trace, ordered by start time: `service  name  duration  attributes`. */
export function traceTree(spans: SpanRecord[], traceId: string): string {
  const own = spans.filter(span => span.traceId === traceId);
  const ids = new Set(own.map(span => span.spanId));
  const children = new Map<string | null, SpanRecord[]>();
  for (const span of own) {
    const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : null;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const lines: string[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      const attributes = Object.entries(span.attributes).map(([key, value]) => `${key}=${String(value)}`).join(' ');
      lines.push(`${'  '.repeat(depth)}${span.name} [${span.service}] ${span.durationMs.toFixed(1)}ms${span.status === 'error' ? ' ERROR' : ''}${attributes ? `  ${attributes}` : ''}`);
      visit(span.spanId, depth + 1);
    }
  };
  visit(null, 0);
  return lines.join('\n');
}
