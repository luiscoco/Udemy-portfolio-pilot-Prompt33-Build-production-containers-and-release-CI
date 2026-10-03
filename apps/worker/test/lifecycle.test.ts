import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainSchedule, startHealthServer, WorkerLifecycle } from '../src/lifecycle.js';

afterEach(() => { vi.useRealTimers(); });

describe('worker graceful shutdown', () => {
  it('reserves a finalize window inside the grace period', () => {
    expect(drainSchedule(25000)).toEqual({ abortAfterMs: 20000, finalizeMs: 5000, exitAfterMs: 25000 });
    expect(drainSchedule(3000)).toEqual({ abortAfterMs: 2000, finalizeMs: 1000, exitAfterMs: 3000 });
  });
  it('stops claiming immediately but aborts running work only at the drain deadline', () => {
    vi.useFakeTimers();
    const lifecycle = new WorkerLifecycle('agent', 9000);
    const aborted = vi.fn();
    lifecycle.onDrainDeadline(aborted);
    expect(lifecycle.signal.aborted).toBe(false);
    expect(lifecycle.beginDrain()).toBe(true);
    expect(lifecycle.beginDrain()).toBe(false);
    expect(lifecycle.signal.aborted).toBe(true);
    vi.advanceTimersByTime(5999); expect(aborted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(aborted).toHaveBeenCalledOnce();
    // Work that starts during the drain still respects the same absolute deadline.
    const late = vi.fn(); lifecycle.onDrainDeadline(late);
    vi.advanceTimersByTime(0); expect(late).toHaveBeenCalledOnce();
  });
  it('work that settles before the deadline is never aborted', () => {
    vi.useFakeTimers();
    const lifecycle = new WorkerLifecycle('agent', 9000), aborted = vi.fn();
    const dispose = lifecycle.onDrainDeadline(aborted);
    lifecycle.beginDrain(); dispose();
    vi.advanceTimersByTime(60000);
    expect(aborted).not.toHaveBeenCalled();
  });
  it('health endpoint reports draining without queue or tenant details', async () => {
    const lifecycle = new WorkerLifecycle('agent', 5000);
    const server = await startHealthServer(lifecycle, 0, '127.0.0.1');
    try {
      const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({ status: 'ready', role: 'agent', active: 0 });
      lifecycle.beginDrain();
      const draining = await fetch(`${base}/health/ready`);
      expect(draining.status).toBe(503); expect(await draining.json()).toEqual({ status: 'draining', role: 'agent', active: 0 });
      expect((await fetch(`${base}/health/ready`, { method: 'POST' })).status).toBe(405);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
