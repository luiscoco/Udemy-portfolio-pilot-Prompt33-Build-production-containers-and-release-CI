import { describe, expect, it } from 'vitest';
import type { RedisClient } from '@portfolio-pilot/db';
import { RateLimiter } from './rate-limit';

/** Minimal shared Redis double: two limiters (two API replicas) talk to the same counters. */
function sharedRedis() {
  const counts = new Map<string, number>(), ttls = new Map<string, number>();
  const client = { multi() {
    const ops: Array<() => unknown> = [];
    const chain = {
      incr(key: string) { ops.push(() => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; }); return chain; },
      pExpire(key: string, ms: number) { ops.push(() => { ttls.set(key, ms); return 1; }); return chain; },
      async exec() { return ops.map(op => op()); }
    };
    return chain;
  } } as unknown as RedisClient;
  return { client, counts, ttls };
}

describe('per-user rate limits', () => {
  it('shares one window across replicas and isolates users', async () => {
    const redis = sharedRedis(), now = () => 120000;
    const a = new RateLimiter(async () => redis.client, { api: 3, agent_submit: 1 }, now);
    const b = new RateLimiter(async () => redis.client, { api: 3, agent_submit: 1 }, now);
    const results = [await a.check('api', 'alice'), await b.check('api', 'alice'), await a.check('api', 'alice'), await b.check('api', 'alice')];
    expect(results.map(r => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ source: 'redis', remaining: 0, retryAfterSeconds: 60 });
    expect((await b.check('api', 'bob')).allowed).toBe(true);
    expect((await a.check('agent_submit', 'alice')).allowed).toBe(true);
    expect((await b.check('agent_submit', 'alice')).allowed).toBe(false);
    expect([...redis.ttls.values()].every(ms => ms === 120000)).toBe(true);
  });
  it('starts a new window after the minute boundary', async () => {
    let clock = 59000;
    const limiter = new RateLimiter(async () => sharedRedis().client, { api: 1, agent_submit: 1 }, () => clock);
    const redis = sharedRedis();
    const shared = new RateLimiter(async () => redis.client, { api: 1, agent_submit: 1 }, () => clock);
    expect((await shared.check('api', 'u')).allowed).toBe(true);
    expect((await shared.check('api', 'u'))).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    clock = 60000;
    expect((await shared.check('api', 'u')).allowed).toBe(true);
    expect(limiter).toBeDefined();
  });
  it('degrades to a bounded per-replica window when Redis is down or slow, never to unlimited', async () => {
    const down = new RateLimiter(async () => { throw new Error('ECONNREFUSED'); }, { api: 2, agent_submit: 1 }, () => 0);
    const decisions = [await down.check('api', 'u'), await down.check('api', 'u'), await down.check('api', 'u')];
    expect(decisions.map(d => [d.allowed, d.source])).toEqual([[true, 'local'], [true, 'local'], [false, 'local']]);
    const hanging = new RateLimiter(() => new Promise<RedisClient | null>(() => {}), { api: 1, agent_submit: 1 }, () => 0);
    const started = Date.now();
    expect(await hanging.check('api', 'u')).toMatchObject({ allowed: true, source: 'local' });
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await hanging.check('api', 'u')).allowed).toBe(false);
  });
});
