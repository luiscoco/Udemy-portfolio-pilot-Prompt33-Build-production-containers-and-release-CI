// Shared browser-test environment (milestone 31). `npm run test:browser` sets E2E_* for every spec;
// the per-milestone variables from earlier lessons still work when a spec is run on its own.
export { isDisposableDatabase } from '../../../../tests/support/disposable-database';

/** The single public origin under test (proxy in the harness, Vite dev server otherwise). */
export const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

/** The disposable database behind the servers under test. */
export function e2eDatabaseUrl(legacyVariable: string): string | undefined {
  return process.env.E2E_DATABASE_URL ?? process.env[legacyVariable];
}

/** Redis used by the servers under test (specs that dispatch the outbox themselves need it). */
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** Cookie the harness proxy honours to hold a browser context on one API replica (0 or 1). */
export const PIN_COOKIE = process.env.E2E_PIN_COOKIE;
