import { parseServerConfig } from '@portfolio-pilot/config/server';
import { checkDatabase, checkRedis } from '@portfolio-pilot/db';
import { readinessResponseSchema, REQUEST_ID_HEADER } from '@portfolio-pilot/contracts';
import { getRequestId } from '../../../../lib/http';
import { isDraining } from '../../../../lib/lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const CHECK_MS = 1500;
const bounded = (check: Promise<boolean>) => Promise.race([check.catch(() => false), new Promise<boolean>(resolve => setTimeout(() => resolve(false), CHECK_MS).unref?.())]);
/**
 * Readiness answers "should this replica receive new traffic?". It fails (503) while the replica
 * drains or when configuration is invalid. Shared PostgreSQL/Redis outages affect every replica
 * equally, so they are reported as `degraded` with 200: failing them would remove all replicas at
 * once and replace honest API errors with a gateway failure. Routes still return 503 per request.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let postgres = false, redis = false, configured = false;
  try {
    const config = parseServerConfig(process.env);
    configured = Boolean(config.DATABASE_URL);
    [postgres, redis] = await Promise.all([
      config.DATABASE_URL ? bounded(checkDatabase(config.DATABASE_URL)) : false,
      config.REDIS_URL ? bounded(checkRedis(config.REDIS_URL)) : false
    ]);
  } catch { configured = false; }
  const status = isDraining() ? 'draining' : !configured ? 'unavailable' : postgres && redis ? 'ready' : 'degraded';
  const body = readinessResponseSchema.parse({ status, dependencies: { postgres: postgres ? 'up' : 'down', redis: redis ? 'up' : 'down' }, requestId });
  return Response.json(body, { status: status === 'draining' || status === 'unavailable' ? 503 : 200, headers: { [REQUEST_ID_HEADER]: requestId, 'cache-control': 'no-store' } });
}
