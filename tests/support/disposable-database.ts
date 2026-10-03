/**
 * Acceptance suites create, mutate and delete rows freely, so they refuse any database that was not
 * created for testing. Accepted: loopback databases named `pp_test_*` (created and dropped by
 * `npm run test:integration` / `npm run test:browser`), or a suite's named legacy `*_verify`
 * database from the lesson that introduced it.
 */
export function isDisposableDatabase(url: string | URL, legacy: readonly string[] | RegExp = []): boolean {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) return false;
  const name = parsed.pathname.slice(1);
  return /^pp_test_[a-z0-9_]+$/.test(name) || (legacy instanceof RegExp ? legacy.test(name) : legacy.includes(name));
}

/** Redis used by an acceptance suite must also be loopback (it is flushed by the harness). */
export function isLoopbackRedis(url: string | URL): boolean {
  return ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);
}
