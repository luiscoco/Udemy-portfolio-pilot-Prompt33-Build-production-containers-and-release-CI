// Managed production server for the Next.js API (milestone 30). It replaces `next start` where a
// bounded graceful shutdown is required: SIGTERM/SIGINT (or an IPC 'shutdown' message, because
// Windows supervisors cannot deliver SIGTERM) marks the replica draining, so readiness fails and
// new requests are refused with an explicit "not processed" 503 that a proxy may safely retry
// elsewhere; open SSE streams are closed so browsers resume their signed cursor on another replica;
// in-flight requests finish until the deadline; then connections close and the process exits.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import next from 'next';
import { parseServerConfig } from '@portfolio-pilot/config/server';

const dir = fileURLToPath(new URL('.', import.meta.url));
// Container images run this file from the traced `.next/standalone` tree (milestone 33), which has no
// next.config.mjs. Like Next's generated standalone server.js, hand Next the configuration serialized
// by `next build`, in the repository layout too, so both run exactly the configuration that was built.
const builtConfig = new URL('.next/required-server-files.json', import.meta.url);
if (existsSync(builtConfig) && !process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
  const { config: built } = JSON.parse(readFileSync(builtConfig, 'utf8'));
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify({ ...built, distDir: './.next' });
}

process.env.PORTFOLIO_PILOT_MANAGED_SHUTDOWN = 'true';
process.env.NODE_ENV ??= 'production';
const config = parseServerConfig(process.env);
const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.API_HOSTNAME ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a TCP port.');
const graceMs = config.API_SHUTDOWN_GRACE_MS;
const NOT_PROCESSED_HEADER = 'x-portfolio-pilot-not-processed';
const slot = Symbol.for('portfolio-pilot.api-lifecycle');
const lifecycle = globalThis[slot] ??= { draining: false, streams: new Set(), closers: [] };
const log = (event, fields = {}) => console.log(JSON.stringify({ event, instance: config.INSTANCE_ID ?? null, ...fields }));

const app = next({ dev: false, dir, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

let inflight = 0;
const server = createServer((request, response) => {
  // Health probes always reach Next so readiness can report "draining".
  if (lifecycle.draining && !request.url?.startsWith('/api/health/')) {
    const requestId = randomUUID();
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '1', connection: 'close',
      'x-request-id': requestId, [NOT_PROCESSED_HEADER]: 'draining' });
    response.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'This server is restarting. Your request was not processed; please retry.', requestId } }));
    return;
  }
  inflight++;
  let settled = false;
  response.once('close', () => { if (!settled) { settled = true; inflight--; } });
  if (lifecycle.draining) response.setHeader('connection', 'close');
  void handle(request, response);
});
server.listen(port, hostname, () => log('api.listening', { port, hostname }));

async function drain(reason) {
  if (lifecycle.draining) return;
  lifecycle.draining = true;
  const deadline = Date.now() + graceMs;
  log('api.draining', { reason, inflight, streams: lifecycle.streams.size, graceMs });
  // Hard stop even if a dependency or handler hangs.
  setTimeout(() => { log('api.forced_exit', { inflight }); process.exit(1); }, graceMs).unref();
  server.close();
  for (const close of [...lifecycle.streams]) { try { close(); } catch { /* already closed */ } }
  // Leave a margin for closers after waiting for ordinary requests to finish.
  while (inflight > 0 && Date.now() < deadline - 1500) { server.closeIdleConnections(); await sleep(50); }
  const unfinished = inflight;
  server.closeAllConnections();
  for (const closer of lifecycle.closers) await Promise.race([closer().catch(() => undefined), sleep(1000)]);
  log('api.drained', { unfinished });
  process.exit(unfinished ? 1 : 0);
}
process.once('SIGTERM', () => void drain('SIGTERM'));
process.once('SIGINT', () => void drain('SIGINT'));
process.on('message', message => { if (message === 'shutdown') void drain('ipc'); });
// A supervisor that disappears (its IPC channel closes) must not leave an orphaned replica running.
process.on('disconnect', () => void drain('supervisor_disconnected'));
