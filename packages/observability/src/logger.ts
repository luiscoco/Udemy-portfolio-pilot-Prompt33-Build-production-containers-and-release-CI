import { redactLog } from './redaction.js';
import { currentTraceIds } from './telemetry.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Correlation fields. All are opaque identifiers: `actor` is the keyed pseudonym from `actorRef`, never
 * a user ID; `sseEventId` is the browser-visible event ID. Anything else passes through `redactLog`.
 */
export interface LogFields {
  requestId?: string | undefined; actor?: string | undefined; jobId?: string | undefined; runId?: string | undefined; toolCallId?: string | undefined; eventId?: string | undefined; sseEventId?: string | undefined;
  articleId?: string | undefined; attempt?: number | undefined; durationMs?: number | undefined; code?: string | undefined; [key: string]: unknown;
}
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSON-lines logger: one object per line with UTC time, level, a stable event name,
 * the service, the active trace/span IDs, and redacted fields. Errors are reduced to a class name;
 * messages, prompts, payloads and configuration never reach the sink.
 */
export function createLogger(service: string, options: { level?: LogLevel; sink?: (line: string, level: LogLevel) => void } = {}) {
  const threshold = ORDER[options.level ?? ((process.env.LOG_LEVEL as LogLevel) in ORDER ? process.env.LOG_LEVEL as LogLevel : 'info')];
  const sink = options.sink ?? ((line, level) => (level === 'error' || level === 'warn' ? console.error : console.log)(line));
  const write = (level: LogLevel, event: string, fields: LogFields = {}, error?: unknown) => {
    if (ORDER[level] < threshold) return;
    const ids = currentTraceIds();
    const errorType = error === undefined ? undefined : error instanceof Error && /^[A-Za-z]{1,48}$/.test(error.name) ? error.name : 'error';
    const record = { ts: new Date().toISOString(), level, event: /^[a-z][a-z0-9_.]{0,63}$/.test(event) ? event : 'invalid_event_name', service,
      ...(ids ? { traceId: ids.traceId, spanId: ids.spanId } : {}), ...(redactLog(fields) as Record<string, unknown>), ...(errorType ? { errorType } : {}) };
    sink(JSON.stringify(record), level);
  };
  return {
    debug: (event: string, fields?: LogFields) => write('debug', event, fields),
    info: (event: string, fields?: LogFields) => write('info', event, fields),
    warn: (event: string, fields?: LogFields, error?: unknown) => write('warn', event, fields, error),
    error: (event: string, fields?: LogFields, error?: unknown) => write('error', event, fields, error)
  };
}
export type Logger = ReturnType<typeof createLogger>;
