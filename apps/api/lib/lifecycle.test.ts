import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiLifecycle } from './lifecycle';
import { EventHub } from './event-hub';
import { eventResponse } from './event-response';
import { GET } from '../app/api/events/route';

beforeEach(() => { vi.stubEnv('DATA_MODE', 'mock'); });
afterEach(() => { vi.unstubAllEnvs(); apiLifecycle().draining = false; apiLifecycle().streams.clear(); });

describe('API drain', () => {
  it('closes open SSE streams with a short retry hint so the browser resumes elsewhere', async () => {
    const hub = new EventHub(async (_scope, cursor) => ({ status: 'ok', cursor, events: [], skipped: 0 }));
    const response = eventResponse(new Request('http://localhost/api/events'), 'demo-alice', new Date(Date.now() + 60000),
      { user: 'v1.u', market: 'v1.m' }, hub, async () => true);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain(': connected');
    expect(apiLifecycle().streams.size).toBe(1);
    for (const close of [...apiLifecycle().streams]) close();
    let rest = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += decoder.decode(chunk.value); }
    expect(rest).toContain('retry: 250');
    expect(apiLifecycle().streams.size).toBe(0);
    expect(hub.size).toBe(0);
  });
  it('refuses new streams while draining with an explicit not-processed response', async () => {
    apiLifecycle().draining = true;
    const response = await GET(new Request('http://localhost/api/events'));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-portfolio-pilot-not-processed')).toBe('draining');
    expect((await response.json()).error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
