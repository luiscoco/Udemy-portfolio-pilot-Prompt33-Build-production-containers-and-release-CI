// Disposable test infrastructure shared by `npm run test:integration` and `npm run test:browser`
// (milestone 31). Every run gets its own PostgreSQL databases and Redis logical databases; shared
// development services (compose `portfolio-pilot-local`, earlier *_verify containers) are never used.
//
// Two ways to supply infrastructure:
//  1. Default: Docker. Two throwaway containers (postgres:17.6-alpine, redis:7.4.5-alpine, the same
//     images as compose.yaml) are started on free loopback ports and removed afterwards. Ports are
//     fixed per container so a deliberate stop/start (browser outage spec) keeps the same address.
//  2. CI service containers: set TEST_POSTGRES_URL (a maintenance database URL whose role may
//     CREATE/DROP DATABASE) and TEST_REDIS_URL (a Redis dedicated to tests; its logical databases
//     1-15 are FLUSHED). Both must be loopback because every acceptance suite refuses other hosts.
//
// A migrated template database is built once per run; each suite gets `CREATE DATABASE ... TEMPLATE`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from 'redis';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const PG_IMAGE = 'postgres:17.6-alpine', REDIS_IMAGE = 'redis:7.4.5-alpine';
const PG_PASSWORD = 'disposable_test_only';

/** Thrown when a prerequisite is missing; runners print it and exit 2 (not a test failure). */
export class PrerequisiteError extends Error {}

export function runId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

function docker(args, { allowFail = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new PrerequisiteError(`Docker CLI is not available (${result.error.code ?? result.error.message}). Install Docker, or set TEST_POSTGRES_URL and TEST_REDIS_URL.`);
  if (result.status !== 0 && !allowFail) throw new PrerequisiteError(`docker ${args[0]} failed: ${(result.stderr || result.stdout).trim().split('\n').at(-1)}`);
  return result.stdout.trim();
}

function loopback(url, name) {
  const parsed = new URL(url);
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  if (parsed.hostname !== '127.0.0.1') throw new PrerequisiteError(`${name} must point to a loopback host (127.0.0.1); acceptance suites refuse remote databases.`);
  return parsed;
}

async function waitFor(label, check, ms = 60000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    try { if (await check()) return; } catch (error) { last = error; }
  }
  throw new PrerequisiteError(`${label} did not become ready: ${last?.message ?? 'timeout'}`);
}

/** A currently free loopback port (the OS picks it; it is released before Docker binds it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = server.address(); server.close(() => resolve(port));
    });
  });
}

/**
 * Starts (or adopts) PostgreSQL + Redis and returns helpers. `label` names containers/databases.
 * Always call `dispose()` in a finally block.
 */
export async function provision(label, log = console.log) {
  const id = runId();
  const owned = [];
  let adminUrl, redisBase;
  if (process.env.TEST_POSTGRES_URL || process.env.TEST_REDIS_URL) {
    if (!process.env.TEST_POSTGRES_URL || !process.env.TEST_REDIS_URL) throw new PrerequisiteError('Set both TEST_POSTGRES_URL and TEST_REDIS_URL, or neither (Docker is then used).');
    adminUrl = loopback(process.env.TEST_POSTGRES_URL, 'TEST_POSTGRES_URL');
    redisBase = loopback(process.env.TEST_REDIS_URL, 'TEST_REDIS_URL');
    log(`infra: using provided PostgreSQL ${adminUrl.host} and Redis ${redisBase.host} (Redis databases 1-15 will be flushed)`);
  } else {
    docker(['info', '--format', '{{.ServerVersion}}']);
    for (const image of [PG_IMAGE, REDIS_IMAGE]) {
      if (!docker(['images', '-q', image])) {
        log(`infra: pulling ${image}`);
        docker(['pull', image]);
      }
    }
    const pgName = `pp-test-${label}-pg-${id}`, redisName = `pp-test-${label}-redis-${id}`;
    const pgPort = await freePort(), redisPort = await freePort();
    docker(['run', '-d', '--name', pgName, '--label', 'portfolio-pilot.test=true', '-p', `127.0.0.1:${pgPort}:5432`,
      '-e', 'POSTGRES_USER=pp_test', '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`, '-e', 'POSTGRES_DB=postgres',
      PG_IMAGE, '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=400']);
    owned.push(pgName);
    docker(['run', '-d', '--name', redisName, '--label', 'portfolio-pilot.test=true', '-p', `127.0.0.1:${redisPort}:6379`, REDIS_IMAGE, 'redis-server', '--save', '', '--appendonly', 'no']);
    owned.push(redisName);
    adminUrl = new URL(`postgresql://pp_test:${PG_PASSWORD}@127.0.0.1:${pgPort}/postgres`);
    redisBase = new URL(`redis://127.0.0.1:${redisPort}`);
    log(`infra: started disposable containers ${pgName} (${adminUrl.port}) and ${redisName} (${redisBase.port})`);
  }
  const admin = async fn => {
    const client = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 2000 });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  };
  await waitFor('PostgreSQL', () => admin(c => c.query('select 1')).then(() => true));
  await waitFor('Redis', async () => {
    const client = createClient({ url: redisBase.href, socket: { connectTimeout: 1000, reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect(); await client.ping(); await client.close(); return true;
  });
  const created = [];
  const urlFor = name => { const url = new URL(adminUrl.href); url.pathname = `/${name}`; return url.href; };
  const template = `pp_test_${id}_template`;
  await admin(c => c.query(`create database "${template}"`));
  created.push(template);
  migrate(urlFor(template), log);

  return {
    id, owned, redisBase: redisBase.href, adminUrl: adminUrl.href,
    pgContainer: owned[0] ?? null, redisContainer: owned[1] ?? null,
    /** A fresh, migrated, empty database cloned from the template. */
    async database(suffix) {
      const name = `pp_test_${id}_${suffix.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`.slice(0, 63);
      await admin(c => c.query(`create database "${name}" template "${template}"`));
      created.push(name);
      return urlFor(name);
    },
    /** Redis logical database `index` (1-15), emptied before use. */
    async redis(index) {
      if (!Number.isInteger(index) || index < 1 || index > 15) throw new Error('Redis test index must be 1-15');
      const url = new URL(redisBase.href); url.pathname = `/${index}`;
      const client = createClient({ url: url.href, socket: { connectTimeout: 1000, reconnectStrategy: false } });
      client.on('error', () => {});
      await client.connect(); await client.flushDb(); await client.close();
      return url.href;
    },
    async dispose({ keep = process.env.TEST_KEEP_INFRA === 'true' } = {}) {
      if (keep) { log(`infra: kept for inspection (TEST_KEEP_INFRA=true): ${owned.join(', ') || created.join(', ')}`); return; }
      if (owned.length) { docker(['rm', '-f', '-v', ...owned], { allowFail: true }); return; }
      await admin(async c => {
        for (const name of created.reverse()) await c.query(`drop database if exists "${name}" with (force)`).catch(() => {});
      }).catch(() => {});
    }
  };
}

/** `prisma migrate deploy` against `url`, using the workspace-cached schema engine when present. */
export function migrate(url, log = console.log) {
  const env = { ...process.env, DATABASE_URL: url };
  const cached = join(root, '.cache/prisma/schema-engine.exe');
  if (!env.PRISMA_SCHEMA_ENGINE_BINARY && process.platform === 'win32' && existsSync(cached)) env.PRISMA_SCHEMA_ENGINE_BINARY = cached;
  const cli = join(root, 'node_modules/prisma/build/index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], { cwd: join(root, 'packages/db'), env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-4).join('\n');
    throw new PrerequisiteError(`prisma migrate deploy failed. If the schema engine could not be downloaded offline, set PRISMA_SCHEMA_ENGINE_BINARY (see lesson 26).\n${detail}`);
  }
  const applied = (result.stdout.match(/migrations? (?:have been )?applied|Applying migration/g) ?? []).length;
  log(`infra: migrated template database (${applied ? 'migrations applied' : 'already current'})`);
}

/** Ensures build outputs exist (or builds them) so suites test the code as it ships. */
export function ensureBuilt(script, outputs, log = console.log) {
  if (process.env.TEST_SKIP_BUILD === 'true') {
    const missing = outputs.filter(path => !existsSync(join(root, path)));
    if (missing.length) throw new PrerequisiteError(`TEST_SKIP_BUILD=true but build outputs are missing: ${missing.join(', ')}. Run: npm run ${script}`);
    log('build: skipped (TEST_SKIP_BUILD=true)');
    return;
  }
  log(`build: npm run ${script}`);
  const npm = process.env.npm_execpath;
  const result = npm
    ? spawnSync(process.execPath, [npm, 'run', ...script.split(' ')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true })
    : spawnSync('npm', ['run', ...script.split(' ')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(result.stdout.slice(-4000) + result.stderr.slice(-4000));
    throw new Error(`npm run ${script} failed; fix the build before running tests.`);
  }
}
