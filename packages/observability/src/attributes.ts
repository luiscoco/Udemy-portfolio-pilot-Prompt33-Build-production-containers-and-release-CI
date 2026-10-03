import { createHmac } from 'node:crypto';

/**
 * Telemetry safety rules (milestone 32).
 *
 * - Span attributes may carry opaque correlation IDs (request, run, job, tool call, event, article)
 *   and bounded enums. They never carry prompts, answers, article text, URLs, money, quantities,
 *   prices, raw errors, credentials or user IDs (only the keyed `pp.actor` pseudonym).
 * - Metric labels are stricter: a fixed key allowlist and low-cardinality values only. No ID of any
 *   kind (not even pseudonymous) may become a label, because every distinct value is a new series
 *   that is retained, aggregated and exported to the monitoring backend.
 */
const SENSITIVE_KEY = /secret|token|password|authorization|cookie|credential|api.?key|prompt|content|text|answer|summary|title|arguments|input|output|response|env|connection|database.?url|email|name|url|price|quantity|amount|value|cost_basis|fee|balance|user.?id|owner/i;
const ATTRIBUTE_KEY = /^(?:pp|http|error|messaging|service)\.[a-z0-9_.]{1,64}$/;
/** Keys explicitly allowed even though they contain a sensitive-looking word. */
const ALLOWED_KEYS = new Set(['pp.usage.cost_usd', 'pp.usage.tokens', 'http.response.status_code', 'http.request.method', 'messaging.message.id', 'messaging.destination.name', 'error.type']);

export type AttributeValue = string | number | boolean;
export type SafeAttributes = Record<string, AttributeValue>;

/** Drops anything that is not an allowed key with a bounded scalar value. */
export function safeAttributes(input: Record<string, unknown> | undefined): SafeAttributes {
  const output: SafeAttributes = {};
  if (!input) return output;
  for (const [key, value] of Object.entries(input).slice(0, 40)) {
    if (!ATTRIBUTE_KEY.test(key)) continue;
    if (!ALLOWED_KEYS.has(key) && SENSITIVE_KEY.test(key.replace(/^pp\./, ''))) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) output[key] = value;
    else if (typeof value === 'string' && /^[\w.:@/-]{0,128}$/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) output[key] = value;
  }
  return output;
}

/** The only metric label keys. Values must also pass `labelValue`. */
export const METRIC_LABEL_KEYS = ['component', 'outcome', 'mode', 'queue', 'reason', 'kind', 'tool', 'status', 'code', 'role', 'data_mode', 'accounting', 'event_type'] as const;
export type MetricLabelKey = (typeof METRIC_LABEL_KEYS)[number];
export type MetricLabels = Partial<Record<MetricLabelKey, string>>;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_RANDOM = /[a-z0-9]{20,}/i;

/**
 * Low-cardinality enum-like values only. Anything that looks like an identifier, a number or free
 * text becomes "other": a mistake costs a less useful dashboard, never a data leak.
 */
export function labelValue(value: string): string {
  return /^[a-z][a-z0-9_.:-]{0,47}$/.test(value) && !UUID.test(value) && !LONG_RANDOM.test(value) && !/\d{3,}/.test(value) && !value.includes('@') ? value : 'other';
}
/** Public agent tool names are camelCase, so `tool` uses an exact value list (mixed case otherwise admits tickers). */
const TOOL_LABELS = new Set(['getPortfolioSummary', 'listHoldings', 'listTransactions', 'getQuotes', 'searchNews', 'getNewsArticle', 'delegation', 'researchExternal', 'proposeChange', 'other']);
export function safeLabels(labels: MetricLabels | Record<string, string | undefined> = {}): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!(METRIC_LABEL_KEYS as readonly string[]).includes(key)) throw new Error(`Metric label "${key}" is not allowlisted.`);
    if (value !== undefined) output[key] = key === 'tool' ? (TOOL_LABELS.has(value) ? value : 'other') : labelValue(value);
  }
  return output;
}

let actorKey: Buffer | null = null;
/**
 * Keyed, stable pseudonym for a user: `act_` + 16 hex characters of HMAC-SHA256. Every replica derives
 * the same key (OBSERVABILITY_ACTOR_KEY, else derived from the shared AUTH_SECRET), so one user
 * correlates across the API and workers, while logs and traces never contain the user ID. Without
 * either secret (local development only) a fixed development key is used and the value is NOT a
 * protection: it only keeps correlation working.
 */
export function actorRef(userId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!actorKey) {
    const explicit = env.OBSERVABILITY_ACTOR_KEY;
    actorKey = explicit && explicit.length >= 32 ? Buffer.from(explicit)
      : env.AUTH_SECRET ? createHmac('sha256', env.AUTH_SECRET).update('portfolio-pilot/actor-ref/v1').digest()
      : Buffer.from('portfolio-pilot-development-only-actor-key');
  }
  return `act_${createHmac('sha256', actorKey).update(userId).digest('hex').slice(0, 16)}`;
}
/** Test hook: forget the derived key so a different environment applies. */
export function resetActorKey() { actorKey = null; }

/**
 * Attributes from third-party instrumentation (Next.js, Better Auth) that may leave the process.
 * Everything else they record — URLs with query strings (`http.target`, `url.*`), SQL text, user
 * fields — is dropped by the exporter wrapper, whatever the library decides to capture.
 */
const THIRD_PARTY_KEYS = new Set(['next.span_type', 'next.span_name', 'next.span_category', 'next.route', 'next.rsc', 'http.route', 'http.method', 'http.status_code',
  'better_auth.operation_id', 'db.operation.name', 'db.collection.name', 'db.system', 'db.system.name']);
export function isExportableAttribute(key: string, value: unknown): boolean {
  if (Object.keys(safeAttributes({ [key]: value })).length) return true;
  if (!THIRD_PARTY_KEYS.has(key)) return false;
  return typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 200 && !/[?#]|:\/\/|@/.test(value));
}
export function exportableAttributes(attributes: Record<string, unknown>): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(attributes).filter(([key, value]) => isExportableAttribute(key, value))) as Record<string, AttributeValue>;
}
