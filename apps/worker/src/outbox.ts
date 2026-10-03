import type { ClaimedEvent, OutboxRepository } from '@portfolio-pilot/db';
import { retryDelay } from './ingestion.js';
import { actorRef, inSpan, metric } from '@portfolio-pilot/observability';

type PublishableEvent = NonNullable<ClaimedEvent['event']>;
export type Publish = (event: PublishableEvent) => Promise<{ streamKey: string; entryId: string }>;
export interface DispatchOptions { owner: string; batchSize: number; leaseMs: number; maxAttempts: number; random?: () => number; processNews?: (eventId: string) => Promise<void> }
export interface DispatchResult { claimed: number; published: number; fannedOut: number; retried: number; dead: number; lost: number }

/** Persisted error text must never carry connection strings or credentials. */
export function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown publish failure';
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 200);
}

/**
 * One dispatcher pass: claim a leased batch, deliver each event in sequence order, then record the
 * outcome with the claim token. A crash between publish and markPublished leaves the row PENDING;
 * after the lease expires it is published again with the SAME event UUID. That is the documented
 * at-least-once duplicate, which consumers absorb by deduplicating on the UUID.
 */
export async function dispatchOnce(repository: OutboxRepository, publish: Publish, options: DispatchOptions): Promise<DispatchResult> {
  const result: DispatchResult = { claimed: 0, published: 0, fannedOut: 0, retried: 0, dead: 0, lost: 0 };
  const claims = await repository.claim(options.owner, { limit: options.batchSize, leaseMs: options.leaseMs, maxAttempts: options.maxAttempts });
  result.claimed = claims.length;
  for (const claim of claims) {
    const type = claim.event?.type ?? 'invalid';
    // Continue the trace of the transaction that wrote this row (an article, a run, a user action).
    await inSpan('outbox.dispatch', { 'pp.event.id': claim.id, 'pp.event.type': type, 'pp.job.attempt': claim.attempts,
      ...(claim.event?.audience.kind === 'user' ? { 'pp.actor': actorRef(claim.event.audience.userId) } : {}),
      ...(claim.event?.entityType === 'news_article' ? { 'pp.article.id': claim.event.entityId } : {}),
      ...(claim.event?.entityType === 'agent_run' ? { 'pp.run.id': claim.event.entityId } : {}) }, async span => {
      if (claim.event && claim.attempts === 1) metric.queueAge((Date.now() - Date.parse(claim.event.occurredAt)) / 1000, { queue: 'outbox', event_type: type });
      let outcome: 'published' | 'fanned_out' | 'retry' | 'dead' | 'lost';
      try {
        if (!claim.event) {
          // An unknown schema version or corrupt payload cannot succeed by retrying; park it for an operator.
          outcome = await repository.markFailed(claim, claim.invalidReason ?? 'Invalid envelope', 0, 0) === 'dead' ? 'dead' : 'lost';
        } else if (claim.event.audience.kind === 'system') {
          // Owner notifications written here inherit this span's trace context.
          const created = await repository.fanOutNews(claim); outcome = 'fanned_out';
          span.setAttribute('pp.notifications', created);
        } else {
          if (claim.event.type === 'news.available') await inSpan('research.process_news', { 'pp.event.id': claim.event.id }, () => options.processNews?.(claim.event!.id));
          // The Redis entry records this span's context, so SSE delivery joins the trace.
          const delivery = await publish(claim.event);
          outcome = await repository.markPublished(claim, delivery) ? 'published' : 'lost';
        }
      } catch (error) {
        outcome = await repository.markFailed(claim, sanitizeError(error), retryDelay(claim.attempts - 1, null, Date.now(), options.random), options.maxAttempts);
        span.setStatus({ code: 2 }); span.setAttribute('error.type', error instanceof Error && /^\w{1,48}$/.test(error.name) ? error.name : 'error');
        metric.error('outbox', 'dispatch_failed');
      }
      span.setAttribute('pp.outcome', outcome);
      metric.outboxDispatched(outcome, type);
      if (outcome === 'published') result.published++; else if (outcome === 'fanned_out') result.fannedOut++;
      else if (outcome === 'retry') result.retried++; else if (outcome === 'dead') result.dead++; else result.lost++;
    }, { parent: claim.traceparent, kind: 'consumer' });
  }
  return result;
}
