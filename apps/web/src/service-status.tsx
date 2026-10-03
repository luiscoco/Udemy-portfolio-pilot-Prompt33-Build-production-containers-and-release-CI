import { useQuery } from '@tanstack/react-query';
import { readinessResponseSchema, type ReadinessResponse } from '@portfolio-pilot/contracts';

export type ServiceView = { kind: 'ok' } | { kind: 'unreachable' | 'database' | 'events' | 'restarting'; title: string; detail: string };
/**
 * Plain-language service state from the public readiness probe (this tab's own event stream is
 * reported separately by ConnectionStatus). It distinguishes what still works from what stopped,
 * and never implies that unsaved work was saved.
 */
export function describeService(readiness: ReadinessResponse | null, reachable: boolean): ServiceView {
  if (!reachable) return { kind: 'unreachable', title: 'PortfolioPilot cannot be reached',
    detail: 'What you see may be out of date, and nothing new can be saved until the connection returns. Changes you already saw confirmed are stored.' };
  if (readiness?.dependencies.postgres === 'down') return { kind: 'database', title: 'Saved data is temporarily unavailable',
    detail: 'New changes are not being accepted, so nothing is partially saved. Assistant answers that were interrupted will be labeled interrupted, never completed.' };
  if (readiness?.status === 'draining') return { kind: 'restarting', title: 'A server is restarting',
    detail: 'Your connection is moving to another server. If a request was refused, it was not processed and can be retried.' };
  if (readiness?.dependencies.redis === 'down') return { kind: 'events', title: 'Live updates are paused',
    detail: 'Everything shown comes from saved records. Use Refresh to see the latest; assistant answers still finish and are saved.' };
  return { kind: 'ok' };
}

async function readiness(signal: AbortSignal): Promise<ReadinessResponse | null> {
  const response = await fetch('/api/health/ready', { signal, headers: { Accept: 'application/json' } });
  // 503 still carries a readiness body (draining/unavailable); anything else means unreachable.
  const parsed = readinessResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('unreachable');
  return parsed.data;
}

/** Rendered by the session gate, so it stays visible even when signing in or loading a snapshot fails. */
export function ServiceStatus() {
  const query = useQuery({ queryKey: ['service-readiness'], queryFn: ({ signal }) => readiness(signal), retry: false,
    refetchInterval: query => query.state.data?.status === 'ready' && !query.state.error ? 15000 : 4000 });
  const view = describeService(query.data ?? null, !query.isError);
  if (view.kind === 'ok' || query.isPending) return null;
  return <div className={`data-state ${view.kind === 'database' || view.kind === 'unreachable' ? 'error' : 'stale'} service-status`} role={view.kind === 'database' || view.kind === 'unreachable' ? 'alert' : 'status'} data-service-state={view.kind}>
    <span className="state-mark" aria-hidden="true">{view.kind === 'events' ? 'i' : '!'}</span>
    <div><strong>{view.title}</strong><p>{view.detail}</p></div>
    <button type="button" className="text-button" onClick={() => void query.refetch()}>Check again</button>
  </div>;
}
