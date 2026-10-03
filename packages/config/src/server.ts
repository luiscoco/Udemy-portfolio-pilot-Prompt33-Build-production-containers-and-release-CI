import { z } from 'zod';
import { isAbsolute } from 'node:path';

function serviceUrl(protocols: string[]) {
  return z.string().trim().min(1).refine((value) => {
    try {
      const url = new URL(value);
      return protocols.includes(url.protocol) && Boolean(url.hostname) && !url.hash;
    } catch { return false; }
  }, 'Invalid service URL');
}

export const serverConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DEMO_AUTH_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  AUTH_BASE_URL: z.string().url().default('http://localhost:5173'),
  AUTH_SECRET: z.string().min(32).optional(),
  ENTRA_CLIENT_ID: z.string().min(1).optional(),
  ENTRA_CLIENT_SECRET: z.string().min(1).optional(),
  ENTRA_TENANT_ID: z.string().uuid().optional(),
  DATA_MODE: z.enum(['mock', 'live']),
  ALPACA_API_KEY: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  ALPACA_API_SECRET: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  ALPACA_STORAGE_DISPLAY_RIGHTS_CONFIRMED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(10000),
  INGESTION_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(30000),
  MOCK_NEWS_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(30000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  OUTBOX_POLL_MS: z.coerce.number().int().min(50).max(60000).default(500),
  MOCK_START_AT: z.preprocess(v => v === '' ? undefined : v, z.iso.datetime().optional()),
  MOCK_SCENARIO: z.enum(['ordinary', 'duplicates', 'corrections', 'conflicts', 'missing_quotes', 'rate_limit', 'outage']).default('ordinary'),
  AGENT_MODE: z.preprocess((v) => v === '' ? undefined : v, z.enum(['mock', 'claude']).default('mock')),
  // Pace of the deterministic mock's streamed chunks, so progress and cancellation are observable locally.
  AGENT_MOCK_STREAM_DELAY_MS: z.coerce.number().int().min(0).max(1000).default(25),
  AGENT_SPECIALISTS_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  RESEARCH_MCP_MODE: z.enum(['off', 'fixture', 'live']).default('off'),
  RESEARCH_MCP_SCRIPT_PATH: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  RESEARCH_MCP_TOKEN: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  AGENT_MODEL_ID: z.preprocess((v) => v === '' ? undefined : v, z.string().trim().min(1).optional()),
  AGENT_MAX_PROMPT_BYTES: z.coerce.number().int().min(256).max(1000000).default(48000),
  AGENT_MAX_TOOL_RESULT_BYTES: z.coerce.number().int().min(256).max(100000).default(24000),
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(50).default(6),
  AGENT_WALL_CLOCK_MS: z.coerce.number().int().min(100).max(600000).default(90000),
  AGENT_MAX_COST_USD: z.coerce.number().min(0.000001).max(100).default(0.1),
  // Extra reservation for the response that crosses the SDK's approximate cost cap.
  AGENT_COST_OVERFLOW_USD: z.coerce.number().nonnegative().max(100).default(0.1),
  AGENT_DAILY_BUDGET_USD: z.coerce.number().min(0.000001).max(1000).default(2),
  AGENT_CONTEXT_RESET_TURNS: z.coerce.number().int().min(1).max(100).default(8),
  AGENT_WORKSPACE_DIR: z.preprocess((v) => v === '' ? undefined : v, z.string().trim().min(1).optional()),
  SESSION_ARTIFACT_BACKEND: z.enum(['local', 'azure']).default('local'),
  SESSION_ARTIFACT_DIR: z.preprocess(v => v === '' ? undefined : v, z.string().refine(isAbsolute).optional()),
  SESSION_BLOB_CONTAINER_URL: z.preprocess(v => v === '' ? undefined : v, z.string().url().optional()),
  AZURE_TENANT_ID: z.string().uuid().optional(),
  AZURE_CLIENT_ID: z.string().uuid().optional(),
  AZURE_FEDERATED_TOKEN_FILE: z.string().refine(isAbsolute).optional(),
  // Operational controls (milestone 30). Limits are enforced in shared PostgreSQL/Redis, so every
  // API and worker replica must receive the same values.
  INSTANCE_ID: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional()),
  API_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100000).default(300),
  AGENT_SUBMIT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(12),
  AGENT_MAX_ACTIVE_RUNS_PER_USER: z.coerce.number().int().min(1).max(50).default(2),
  AGENT_GLOBAL_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(8),
  AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).max(600000).default(25000),
  WORKER_HEALTH_PORT: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().int().min(1).max(65535).optional()),
  WORKER_HEALTH_HOST: z.enum(['127.0.0.1', '0.0.0.0', '::1', '::']).default('127.0.0.1'),
  OPS_REPORT_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  STUCK_QUEUED_MS: z.coerce.number().int().min(1000).max(86400000).default(120000),
  STUCK_RUNNING_GRACE_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  DATABASE_URL: z.preprocess((v) => v === '' ? undefined : v, serviceUrl(['postgresql:', 'postgres:']).optional()),
  REDIS_URL: z.preprocess((v) => v === '' ? undefined : v, serviceUrl(['redis:', 'rediss:']).optional()),
  ANTHROPIC_API_KEY: z.preprocess((v) => v === '' ? undefined : v, z.string().optional()),
  // Milestone 32 telemetry. The actor pseudonym key defaults to one derived from AUTH_SECRET; set this
  // to rotate it independently. Exporter settings use the standard OTEL_* variables (lesson 32).
  OBSERVABILITY_ACTOR_KEY: z.preprocess(v => v === '' ? undefined : v, z.string().min(32).optional()),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OTEL_TRACES_EXPORTER: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^(none|otlp|console|file)(,(none|otlp|console|file))*$/).optional()),
  OTEL_METRICS_EXPORTER: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^(none|otlp|console|prometheus)(,(none|otlp|console|prometheus))*$/).optional()),
  PORTFOLIO_PILOT_TRACE_DIR: z.preprocess(v => v === '' ? undefined : v, z.string().refine(isAbsolute).optional())
}).superRefine((value, ctx) => {
  if (value.SESSION_ARTIFACT_BACKEND === 'azure') for (const key of ['SESSION_BLOB_CONTAINER_URL', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE'] as const) {
    if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required for Azure artifacts` });
  }
  if (value.RESEARCH_MCP_MODE !== 'off' && !value.AGENT_SPECIALISTS_ENABLED) ctx.addIssue({ code: 'custom', path: ['RESEARCH_MCP_MODE'], message: 'External research requires specialists enabled' });
  if (value.RESEARCH_MCP_MODE === 'live' && (!value.RESEARCH_MCP_SCRIPT_PATH || !value.RESEARCH_MCP_TOKEN)) ctx.addIssue({ code: 'custom', path: ['RESEARCH_MCP_SCRIPT_PATH'], message: 'Live stdio research requires a reviewed absolute script path and a dedicated token' });
  if (value.RESEARCH_MCP_SCRIPT_PATH && !isAbsolute(value.RESEARCH_MCP_SCRIPT_PATH)) ctx.addIssue({ code: 'custom', path: ['RESEARCH_MCP_SCRIPT_PATH'], message: 'Use a reviewed absolute Node.js server script path' });
  const origin = new URL(value.AUTH_BASE_URL);
  if (origin.origin !== value.AUTH_BASE_URL || origin.username || origin.password) ctx.addIssue({ code: 'custom', path: ['AUTH_BASE_URL'], message: 'Use an exact public origin without a path' });
  if (value.NODE_ENV === 'production') {
    if (value.DEMO_AUTH_ENABLED) ctx.addIssue({ code: 'custom', path: ['DEMO_AUTH_ENABLED'], message: 'Demo authentication is forbidden in production' });
    if (origin.protocol !== 'https:') ctx.addIssue({ code: 'custom', path: ['AUTH_BASE_URL'], message: 'Production requires HTTPS' });
    for (const key of ['AUTH_SECRET', 'DATABASE_URL', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_TENANT_ID'] as const) {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` });
    }
  }
  if (value.DEMO_AUTH_ENABLED && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) ctx.addIssue({ code: 'custom', path: ['AUTH_BASE_URL'], message: 'Demo authentication requires a loopback public origin' });
  const oidc = [value.ENTRA_CLIENT_ID, value.ENTRA_CLIENT_SECRET, value.ENTRA_TENANT_ID];
  if (oidc.some(Boolean) && !oidc.every(Boolean)) ctx.addIssue({ code: 'custom', path: ['ENTRA_CLIENT_ID'], message: 'Provide all three Entra settings or none' });
  if (value.DATA_MODE === 'live') {
    for (const key of ['DATABASE_URL', 'REDIS_URL'] as const) {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in live mode` });
    }
  }
  // A replica-local secret would make session cookies and signed SSE cursors fail on the other replica.
  if (value.INSTANCE_ID && !value.AUTH_SECRET) ctx.addIssue({ code: 'custom', path: ['AUTH_SECRET'], message: 'Multi-instance deployments require one shared AUTH_SECRET' });
  if (value.OTEL_TRACES_EXPORTER?.split(',').includes('file')) {
    if (!value.PORTFOLIO_PILOT_TRACE_DIR) ctx.addIssue({ code: 'custom', path: ['PORTFOLIO_PILOT_TRACE_DIR'], message: 'The file trace exporter needs an absolute PORTFOLIO_PILOT_TRACE_DIR' });
    // Local inspection only: span files are unrotated and would sit on a pod's disk.
    if (value.NODE_ENV === 'production') ctx.addIssue({ code: 'custom', path: ['OTEL_TRACES_EXPORTER'], message: 'The file trace exporter is for local inspection only; use otlp in production' });
  }
  if (value.AGENT_WORKER_CONCURRENCY > value.AGENT_GLOBAL_CONCURRENCY) ctx.addIssue({ code: 'custom', path: ['AGENT_WORKER_CONCURRENCY'], message: 'Per-worker slots cannot exceed the global agent concurrency' });
  if (value.AGENT_MODE === 'claude') {
    for (const key of ['AGENT_MODEL_ID', 'AGENT_WORKSPACE_DIR'] as const) {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in Claude mode` });
    }
  }
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export function parseServerConfig(input: unknown): ServerConfig {
  return serverConfigSchema.parse(input);
}
