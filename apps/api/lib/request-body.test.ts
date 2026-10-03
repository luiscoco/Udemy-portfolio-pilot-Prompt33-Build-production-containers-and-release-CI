import { expect, it, vi } from 'vitest';
import { boundedJsonBody } from './request-body';
it('bounds declared and chunked body bytes before parsing', async () => {
  expect(await boundedJsonBody(new Request('http://localhost', { method: 'POST', body: '{"name":"Growth"}' }))).toEqual({ name: 'Growth' });
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(6000)); }, cancel() { cancelled = true; } });
  await expect(boundedJsonBody(new Request('http://localhost', { method: 'POST', body, duplex: 'half' } as RequestInit))).rejects.toThrow('too large');
  expect(cancelled).toBe(true);
  await expect(boundedJsonBody(new Request('http://localhost', { method: 'POST', body: '{}', headers: { 'Content-Length': '999999' } }))).rejects.toThrow('too large');
});
it('times out stalled bodies and cancels the reader', async () => {
  vi.useFakeTimers();
  try {
    const request = new Request('http://localhost', { method: 'POST', body: new ReadableStream({ start() {} }), duplex: 'half' } as RequestInit);
    const assertion = expect(boundedJsonBody(request)).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(10000); await assertion;
  } finally { vi.useRealTimers(); }
});
