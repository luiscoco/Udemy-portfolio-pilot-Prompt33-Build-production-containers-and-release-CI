export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { parseServerConfig } = await import('@portfolio-pilot/config/server');
  try { parseServerConfig(process.env); }
  catch {
    // Next can retain a listening socket after an instrumentation rejection.
    // Production must terminate rather than remain in a partially prepared state.
    if (process.env.NODE_ENV === 'production') {
      console.error('Server startup refused: invalid configuration. Demo authentication is forbidden in production; HTTPS, a session secret, database and Entra settings are required.');
      process.exit(1);
    }
    throw new Error('Server configuration is invalid.');
  }
  // Tracing/metrics before any route module loads. Exporters are opt-in (OTEL_* variables, lesson 32).
  const { initTelemetry } = await import('@portfolio-pilot/observability');
  const telemetry = initTelemetry({ serviceName: 'portfolio-pilot-api' });
  const { closeConnections: closeDatabase } = await import('@portfolio-pilot/db');
  const closeConnections = async () => { await closeDatabase(); await telemetry.shutdown(); };
  const state = globalThis as typeof globalThis & { __portfolioPilotShutdownRegistered?: boolean };
  if (state.__portfolioPilotShutdownRegistered) return;
  state.__portfolioPilotShutdownRegistered = true;
  // Under server.mjs the managed server owns signals: it drains first, then runs these closers.
  if (process.env.PORTFOLIO_PILOT_MANAGED_SHUTDOWN === 'true') {
    const { apiLifecycle } = await import('./lib/lifecycle');
    apiLifecycle().closers.push(closeConnections);
    return;
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void closeConnections().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  }
}
