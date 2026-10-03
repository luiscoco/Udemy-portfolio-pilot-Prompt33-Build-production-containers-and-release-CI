/** Logs contain bounded metadata, never prompts, payloads, configuration or raw errors. */
export function redactLog(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (depth > 5) return '[TRUNCATED]';
  if (value instanceof Error) return { error: 'operation_failed' };
  if (typeof value === 'string') return value.slice(0, 1000)
    .replace(/(?:https?:\/\/)[^\s]+/gi, '[URL REDACTED]')
    .replace(/\b(?:Bearer\s+\S+|sk-[\w-]+)\b/gi, '[REDACTED]');
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactLog(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) =>
    [key, /secret|token|password|authorization|cookie|credential|api.?key|prompt|content|arguments|tool_input|tool_response|env|connection|database.?url/i.test(key) ? '[REDACTED]' : redactLog(item, depth + 1)]));
  return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : '[REDACTED]';
}
export function logMetadata(value: unknown, sink: (message: string) => void = console.info): void {
  sink(JSON.stringify(redactLog(value)));
}
