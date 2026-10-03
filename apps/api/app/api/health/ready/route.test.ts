import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checks = vi.hoisted(() => ({ database: vi.fn(), redis: vi.fn() }));
vi.mock('@portfolio-pilot/db', () => ({ checkDatabase: checks.database, checkRedis: checks.redis }));
import { GET } from './route';
import { apiLifecycle } from '../../../../lib/lifecycle';

const prior = { database: process.env.DATABASE_URL, redis: process.env.REDIS_URL };
beforeEach(() => {
  vi.stubEnv('DATA_MODE', 'mock');
  process.env.DATABASE_URL = 'postgresql://user:private@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
});
afterEach(() => {
  if (prior.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior.database;
  if (prior.redis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prior.redis;
  apiLifecycle().draining = false;
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('readiness', () => {
  it('reports both dependencies without credentials', async () => {
    checks.database.mockResolvedValue(true);
    checks.redis.mockResolvedValue(true);
    const response = await GET(new Request('http://localhost/api/health/ready'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready', dependencies: { postgres: 'up', redis: 'up' } });
    expect(JSON.stringify(await GET(new Request('http://localhost/api/health/ready')).then((r) => r.json()))).not.toContain('private');
  });
  it('stays in rotation but reports degraded when a shared dependency stops', async () => {
    checks.database.mockResolvedValue(true);
    checks.redis.mockResolvedValue(false);
    const redisDown = await GET(new Request('http://localhost/api/health/ready'));
    expect(redisDown.status).toBe(200);
    expect(await redisDown.json()).toMatchObject({ status: 'degraded', dependencies: { postgres: 'up', redis: 'down' } });
    checks.database.mockResolvedValue(false);
    checks.redis.mockResolvedValue(true);
    expect(await (await GET(new Request('http://localhost/api/health/ready'))).json()).toMatchObject({ status: 'degraded', dependencies: { postgres: 'down', redis: 'up' } });
  });
  it('bounds a hanging dependency check', async () => {
    checks.database.mockResolvedValue(true);
    checks.redis.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    expect(await (await GET(new Request('http://localhost/api/health/ready'))).json()).toMatchObject({ status: 'degraded', dependencies: { redis: 'down' } });
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it('fails readiness while draining so new traffic goes elsewhere', async () => {
    checks.database.mockResolvedValue(true);
    checks.redis.mockResolvedValue(true);
    apiLifecycle().draining = true;
    const response = await GET(new Request('http://localhost/api/health/ready'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'draining' });
  });
  it('is unavailable without database configuration', async () => {
    delete process.env.DATABASE_URL;
    const response = await GET(new Request('http://localhost/api/health/ready'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'unavailable' });
  });
});
