import { describe, expect, it } from 'vitest';
import { describeService } from './service-status';

const ready = (postgres: 'up' | 'down', redis: 'up' | 'down', status: 'ready' | 'degraded' | 'draining' = postgres === 'up' && redis === 'up' ? 'ready' : 'degraded') =>
  ({ status, dependencies: { postgres, redis }, requestId: crypto.randomUUID() });

describe('service state shown to users', () => {
  it('is silent while everything is healthy', () => {
    expect(describeService(ready('up', 'up'), true)).toEqual({ kind: 'ok' });
  });
  it('explains a Redis outage as paused live updates, not data loss', () => {
    const view = describeService(ready('up', 'down'), true);
    expect(view).toMatchObject({ kind: 'events', title: 'Live updates are paused' });
    if (view.kind !== 'ok') expect(view.detail).toContain('still finish and are saved');
  });
  it('explains a database outage without implying anything was saved or completed', () => {
    const view = describeService(ready('down', 'up'), true);
    expect(view).toMatchObject({ kind: 'database' });
    if (view.kind !== 'ok') { expect(view.detail).toContain('nothing is partially saved'); expect(view.detail).toContain('never completed'); }
  });
  it('database outage wins over a simultaneous Redis outage', () => {
    expect(describeService(ready('down', 'down'), true).kind).toBe('database');
  });
  it('reports a draining replica and an unreachable service distinctly', () => {
    expect(describeService(ready('up', 'up', 'draining'), true).kind).toBe('restarting');
    expect(describeService(null, false).kind).toBe('unreachable');
  });
});
