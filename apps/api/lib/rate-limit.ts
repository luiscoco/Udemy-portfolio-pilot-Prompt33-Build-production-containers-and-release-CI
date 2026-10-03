import { parseServerConfig } from '@portfolio-pilot/config/server';
import { redisKeys, type RedisClient } from '@portfolio-pilot/db';
import { optionalRedis } from './cache';

export type RateBucket = 'api' | 'agent_submit';
export type RateDecision = { allowed: boolean; limit: number; remaining: number; retryAfterSeconds: number; source: 'redis' | 'local' };
const WINDOW_MS = 60000;
const REDIS_TIMEOUT_MS = 250;
const LOCAL_MAX_KEYS = 10000;

/**
 * Per-user fixed-window limits shared by every API replica through Redis (INCR + PEXPIRE in one
 * MULTI). During a Redis outage each replica falls back to its own in-memory window: requests keep
 * flowing, but the effective cluster limit becomes replicas x limit. This is a documented
 * degradation, never an unlimited mode. The user ID always comes from the authenticated session.
 */
export class RateLimiter {
  private local = new Map<string, number>();
  constructor(private readonly redis: () => Promise<RedisClient | null>, private readonly limits: Record<RateBucket, number>,
    private readonly now = () => Date.now(), private readonly namespace = 'pp') {}
  async check(bucket: RateBucket, userId: string): Promise<RateDecision> {
    const now = this.now(), window = Math.floor(now / WINDOW_MS), limit = this.limits[bucket];
    const retryAfterSeconds = Math.max(1, Math.ceil(((window + 1) * WINDOW_MS - now) / 1000));
    let count: number | null = null;
    try { count = await this.shared(bucket, userId, window); } catch { count = null; }
    const source = count === null ? 'local' as const : 'redis' as const;
    if (count === null) count = this.counted(`${bucket}:${userId}:${window}`, window);
    return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), retryAfterSeconds, source };
  }
  private async shared(bucket: RateBucket, userId: string, window: number): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        const redis = await this.redis();
        if (!redis) return null;
        const key = redisKeys(this.namespace).rateLimit(bucket, userId, window);
        const [count] = await redis.multi().incr(key).pExpire(key, WINDOW_MS * 2).exec() as unknown as [number, unknown];
        return Number(count);
      })(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), REDIS_TIMEOUT_MS); })]);
    } finally { clearTimeout(timer); }
  }
  private counted(key: string, window: number): number {
    if (this.local.size >= LOCAL_MAX_KEYS) {
      // Bounded memory: drop finished windows first, then the oldest entries.
      for (const existing of this.local.keys()) if (!existing.endsWith(`:${window}`)) this.local.delete(existing);
      while (this.local.size >= LOCAL_MAX_KEYS) this.local.delete(this.local.keys().next().value!);
    }
    const count = (this.local.get(key) ?? 0) + 1;
    this.local.set(key, count);
    return count;
  }
}

let limiter: RateLimiter | undefined;
export function rateLimiter(): RateLimiter {
  if (!limiter) {
    const config = parseServerConfig(process.env);
    limiter = new RateLimiter(optionalRedis, { api: config.API_RATE_LIMIT_PER_MINUTE, agent_submit: config.AGENT_SUBMIT_RATE_LIMIT_PER_MINUTE });
  }
  return limiter;
}
