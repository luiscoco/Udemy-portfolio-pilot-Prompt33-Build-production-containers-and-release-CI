/**
 * Process-wide drain state shared by `server.mjs` (the managed Node server) and the Next.js route
 * bundles. Route bundles are separate module graphs, so the state lives on a global symbol, exactly
 * like the SSE development key. Under `next dev`/`next start` nothing ever sets `draining`.
 */
export type ApiLifecycle = {
  draining: boolean;
  /** Open SSE streams; draining closes them so browsers reconnect to another replica. */
  streams: Set<() => void>;
  /** Connection closers registered by instrumentation, run once in-flight requests have drained. */
  closers: Array<() => Promise<void>>;
};
const slot = Symbol.for('portfolio-pilot.api-lifecycle');
export function apiLifecycle(): ApiLifecycle {
  const state = globalThis as typeof globalThis & { [slot]?: ApiLifecycle };
  return state[slot] ??= { draining: false, streams: new Set(), closers: [] };
}
export function isDraining(): boolean { return apiLifecycle().draining; }
export function trackStream(close: () => void): () => void {
  const streams = apiLifecycle().streams;
  streams.add(close);
  return () => { streams.delete(close); };
}
