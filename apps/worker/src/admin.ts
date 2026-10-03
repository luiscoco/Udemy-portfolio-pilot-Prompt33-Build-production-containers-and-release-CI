import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseServerConfig } from '@portfolio-pilot/config/server';
import { AdminDenied, adminOperations, authorizeOperator, closeConnections, getDatabase, issueOperatorCredential, revokeOperatorCredential, type AdminScope } from '@portfolio-pilot/db';
import { stuckPolicy } from './lifecycle.js';

/**
 * PortfolioPilot administrative recovery command. It has no network listener and there is no admin
 * web page. Run it where the worker runs (for example `kubectl exec` into a worker pod), so access
 * already requires cluster RBAC and database credentials; on top of that every command except
 * break-glass credential issuance requires an expiring, scoped operator token supplied ONLY through
 * PORTFOLIO_ADMIN_TOKEN (never argv, which leaks into shell history and process listings).
 * Every attempt, including denials, is recorded in the append-only AdminAuditLog.
 */
export const USAGE = `Usage: node dist/admin.js <command> [options]
  status                                         Queue depth, outbox state and stuck runs (scope ops:read)
  recover-run --run <id> --confirm <id> --reason <text>
                                                 Fail one STUCK run truthfully and fence its worker (scope runs:recover)
  requeue-outbox --event <id> --confirm <id> --reason <text>
                                                 Return one DEAD outbox event to delivery (scope outbox:requeue)
  issue-credential --operator <name> --scopes <a,b> --ttl-minutes <n> --reason <text>
                                                 Break-glass: requires ADMIN_BOOTSTRAP=issue and database authority
  revoke-credential --credential <id> --reason <text>
                                                 Break-glass: requires ADMIN_BOOTSTRAP=revoke
Operator token: set PORTFOLIO_ADMIN_TOKEN in the environment.`;

const SCOPE: Record<string, AdminScope> = { status: 'ops:read', 'recover-run': 'runs:recover', 'requeue-outbox': 'outbox:requeue' };
export async function runAdmin(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    run: { type: 'string' }, event: { type: 'string' }, confirm: { type: 'string' }, reason: { type: 'string' },
    operator: { type: 'string' }, scopes: { type: 'string' }, 'ttl-minutes': { type: 'string' }, credential: { type: 'string' }, help: { type: 'boolean' } } });
  const command = positionals[0];
  if (values.help || !command || positionals.length !== 1) { out(USAGE); return command || values.help ? 0 : 2; }
  const config = parseServerConfig(env);
  if (!config.DATABASE_URL) { out(JSON.stringify({ ok: false, error: 'DATABASE_URL is required.' })); return 2; }
  const db = await getDatabase(config.DATABASE_URL);
  try {
    if (command === 'issue-credential') {
      if (env.ADMIN_BOOTSTRAP !== 'issue') { out(JSON.stringify({ ok: false, error: 'Set ADMIN_BOOTSTRAP=issue to confirm break-glass credential issuance.' })); return 3; }
      const issued = await issueOperatorCredential(db, { operator: values.operator ?? '', scopes: (values.scopes ?? '').split(',').map(s => s.trim()).filter(Boolean),
        ttlMs: Number(values['ttl-minutes'] ?? 'NaN') * 60000, reason: values.reason ?? '' });
      // The token is shown exactly once; only its SHA-256 digest is stored.
      out(JSON.stringify({ ok: true, credential: { id: issued.id, operator: issued.operator, scopes: issued.scopes, expiresAt: issued.expiresAt }, token: issued.token }));
      return 0;
    }
    if (command === 'revoke-credential') {
      if (env.ADMIN_BOOTSTRAP !== 'revoke') { out(JSON.stringify({ ok: false, error: 'Set ADMIN_BOOTSTRAP=revoke to confirm credential revocation.' })); return 3; }
      out(JSON.stringify({ ok: true, revoked: await revokeOperatorCredential(db, { credentialId: values.credential ?? '', reason: values.reason ?? '' }) }));
      return 0;
    }
    const scope = SCOPE[command];
    if (!scope) { out(USAGE); return 2; }
    const target = command === 'recover-run' ? { targetType: 'agent_run', targetId: values.run ?? '' } : command === 'requeue-outbox' ? { targetType: 'outbox_event', targetId: values.event ?? '' } : {};
    const operator = await authorizeOperator(db, env.PORTFOLIO_ADMIN_TOKEN, scope, { action: command, ...target });
    const ops = adminOperations(db, operator, stuckPolicy(config));
    const result = command === 'status' ? await ops.status()
      : command === 'recover-run' ? await ops.recoverRun({ runId: values.run ?? '', confirm: values.confirm, reason: values.reason })
      : await ops.requeueOutboxEvent({ eventId: values.event ?? '', confirm: values.confirm, reason: values.reason });
    out(JSON.stringify({ ok: true, operator: operator.operator, result }));
    return 0;
  } catch (error) {
    if (error instanceof AdminDenied) { out(JSON.stringify({ ok: false, denied: error.reason, error: error.message })); return 3; }
    out(JSON.stringify({ ok: false, error: 'Administrative command failed; no partial change is reported as applied. Check database connectivity and the audit log.' }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runAdmin(process.argv.slice(2), process.env, line => console.log(line)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 2; }
  finally { await closeConnections().catch(() => undefined); }
}
