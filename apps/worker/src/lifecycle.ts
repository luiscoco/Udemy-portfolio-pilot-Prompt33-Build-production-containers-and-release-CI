import { createServer, type Server } from 'node:http';
import type { ServerConfig } from '@portfolio-pilot/config/server';

/** Stuck-job thresholds shared by the agent worker's monitor and the admin command. */
export const stuckPolicy = (config: ServerConfig) => ({ wallClockMs: config.AGENT_WALL_CLOCK_MS, runningGraceMs: config.STUCK_RUNNING_GRACE_MS, queuedMs: config.STUCK_QUEUED_MS });

/**
 * Bounded graceful shutdown. When draining starts, the worker stops claiming work immediately; work
 * already running may finish until `abortAfterMs`; then it is aborted so it can still persist a
 * truthful interrupted outcome during the final `finalizeMs`; at `exitAfterMs` the process exits even
 * if a dependency hangs. The orchestrator's termination grace period must exceed `exitAfterMs`.
 */
export function drainSchedule(graceMs: number) {
  const finalizeMs = Math.min(5000, Math.floor(graceMs / 3));
  return { abortAfterMs: graceMs - finalizeMs, finalizeMs, exitAfterMs: graceMs };
}

export class WorkerLifecycle {
  private readonly controller = new AbortController();
  private drainStartedAt: number | null = null;
  active = 0;
  constructor(readonly role: string, readonly graceMs: number, private readonly now = () => Date.now()) {}
  /** Aborts when draining starts: loops stop claiming/polling, active work keeps running. */
  get signal() { return this.controller.signal; }
  get draining() { return this.drainStartedAt !== null; }
  beginDrain() {
    if (this.drainStartedAt !== null) return false;
    this.drainStartedAt = this.now();
    this.controller.abort('draining');
    return true;
  }
  /** Milliseconds until active work must be aborted, or null before draining. */
  abortDelayMs(): number | null {
    if (this.drainStartedAt === null) return null;
    return Math.max(0, this.drainStartedAt + drainSchedule(this.graceMs).abortAfterMs - this.now());
  }
  /** Calls `abort` once the drain deadline passes; returns a disposer for work that settles first. */
  onDrainDeadline(abort: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { timer = setTimeout(abort, this.abortDelayMs() ?? 0); timer.unref?.(); };
    if (this.draining) arm(); else this.signal.addEventListener('abort', arm, { once: true });
    return () => { clearTimeout(timer); this.signal.removeEventListener('abort', arm); };
  }
}

/**
 * Optional probe endpoint for orchestrators. It reports only liveness, readiness and an active job
 * count: no queue, tenant or configuration detail. Bind to loopback unless a pod probe needs it.
 */
export function startHealthServer(lifecycle: WorkerLifecycle, port: number, host: string): Promise<Server> {
  const server = createServer((request, response) => {
    const send = (status: number, body: object) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET') return send(405, { status: 'method_not_allowed' });
    if (request.url === '/health/live') return send(200, { status: 'ok' });
    if (request.url === '/health/ready') return lifecycle.draining
      ? send(503, { status: 'draining', role: lifecycle.role, active: lifecycle.active })
      : send(200, { status: 'ready', role: lifecycle.role, active: lifecycle.active });
    return send(404, { status: 'not_found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
