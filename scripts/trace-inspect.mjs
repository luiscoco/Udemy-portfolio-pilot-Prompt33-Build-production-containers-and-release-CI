// `npm run trace:inspect -- [--dir <dir>] [--article <id> | --run <id> | --trace <traceId> | --list]`
// Reads the JSON-lines span files written with OTEL_TRACES_EXPORTER=file (one file per process) and
// prints one trace as a tree across services. Local inspection only (lesson 32); for a UI, use the
// OTLP exporter with the `observability` Compose profile (Jaeger) instead.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './test-support/infra.mjs';

const { values } = parseArgs({ options: { dir: { type: 'string', default: process.env.PORTFOLIO_PILOT_TRACE_DIR ?? join(root, '.local', 'traces') },
  article: { type: 'string' }, run: { type: 'string' }, trace: { type: 'string' }, list: { type: 'boolean', default: false } } });
const { readTraceDirectory, traceTree } = await import(pathToFileURL(join(root, 'packages/observability/dist/index.js')).href);
const spans = readTraceDirectory(values.dir);
if (!spans.length) { console.error(`No spans found in ${values.dir}. Start processes with OTEL_TRACES_EXPORTER=file and PORTFOLIO_PILOT_TRACE_DIR.`); process.exit(2); }

const traces = new Map();
for (const span of spans) traces.set(span.traceId, [...(traces.get(span.traceId) ?? []), span]);
const matching = [...traces.entries()].filter(([traceId, list]) =>
  (!values.trace || traceId === values.trace) &&
  (!values.article || list.some(s => s.attributes['pp.article.id'] === values.article)) &&
  (!values.run || list.some(s => s.attributes['pp.run.id'] === values.run)));
if (values.list || (!values.trace && !values.article && !values.run)) {
  for (const [traceId, list] of matching.slice(-30)) {
    const services = [...new Set(list.map(s => s.service.replace('portfolio-pilot-', '')))].join(',');
    const roots = list.filter(s => !s.parentSpanId || !list.some(p => p.spanId === s.parentSpanId)).map(s => s.name).join(',');
    console.log(`${traceId}  ${String(list.length).padStart(3)} spans  ${list[0].start}  root=${roots}  services=${services}`);
  }
  process.exit(0);
}
if (!matching.length) { console.error('No matching trace.'); process.exit(1); }
for (const [traceId] of matching) console.log(`trace ${traceId}\n${traceTree(spans, traceId)}\n`);
