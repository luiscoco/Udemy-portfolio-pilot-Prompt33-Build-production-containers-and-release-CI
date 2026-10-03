// Starts the local multi-replica topology for demonstrations (milestone 30):
//   proxy :5320 (single origin: React build + /api)  ->  api-a :5321, api-b :5322 (managed servers)
//   worker-1, worker-2 (agent role), outbox-1 (Redis delivery), ingestion-1 (mock news)
// Requires DATABASE_URL, REDIS_URL and AUTH_SECRET (shared by every replica) plus `npm run build`.
// Ctrl+C drains every process gracefully (IPC 'shutdown', the Windows-safe equivalent of SIGTERM).
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createLocalProxy } from './local-proxy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const key of ['DATABASE_URL', 'REDIS_URL', 'AUTH_SECRET']) if (!process.env[key]) throw new Error(`${key} is required.`);
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 5320), origin = `http://127.0.0.1:${PROXY_PORT}`;
const base = { NODE_ENV: 'development', DATA_MODE: 'mock', AGENT_MODE: 'mock', DEMO_AUTH_ENABLED: 'true', AUTH_BASE_URL: origin, ...process.env };
const children = [];
function start(name, script, env, cwd = root) {
  const child = fork(script, [], { cwd, env: { ...base, INSTANCE_ID: name, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { for (const line of String(bytes).split('\n').filter(Boolean)) console.log(`[${name}] ${line}`); });
  children.push({ name, child, exited: once(child, 'exit') });
}
start('api-a', join(root, 'apps/api/server.mjs'), { PORT: '5321' }, join(root, 'apps/api'));
start('api-b', join(root, 'apps/api/server.mjs'), { PORT: '5322' }, join(root, 'apps/api'));
for (const name of ['worker-1', 'worker-2']) start(name, join(root, 'apps/worker/dist/index.js'), { WORKER_ROLE: 'agent' });
start('outbox-1', join(root, 'apps/worker/dist/index.js'), { WORKER_ROLE: 'outbox' });
start('ingestion-1', join(root, 'apps/worker/dist/index.js'), { WORKER_ROLE: 'ingestion' });
const proxy = createLocalProxy({ upstreams: ['http://127.0.0.1:5321', 'http://127.0.0.1:5322'], staticDir: join(root, 'apps/web/dist'),
  log: entry => console.log(`[proxy] ${JSON.stringify(entry)}`) });
proxy.server.listen(PROXY_PORT, '127.0.0.1', () => console.log(`[proxy] PortfolioPilot at ${origin} (two API replicas, two agent workers)`));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  for (const { child } of children) if (child.connected) child.send('shutdown');
  await Promise.race([Promise.all(children.map(c => c.exited)), sleep(30000)]);
  for (const { child } of children) if (child.exitCode === null) child.kill();
  proxy.server.close(); process.exit(0);
}
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
