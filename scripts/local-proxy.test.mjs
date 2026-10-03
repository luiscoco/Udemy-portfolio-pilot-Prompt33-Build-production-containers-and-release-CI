// Run: node --test scripts/local-proxy.test.mjs
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLocalProxy } from './local-proxy.mjs';

const closers = [];
after(async () => { for (const close of closers.reverse()) await close(); });
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  closers.push(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${server.address().port}`;
}
/** A fake API replica that records the requests it actually processed. */
async function replica(name, behavior = () => false) {
  const seen = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/api/health/ready') { res.writeHead(200); res.end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    if (behavior(req, res, body)) return;
    seen.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name }));
  });
  return { url: await listen(server), seen };
}
async function proxyFor(upstreams, options = {}) {
  const proxy = createLocalProxy({ upstreams, healthIntervalMs: 60000, ...options });
  await proxy.probes();
  return { ...proxy, url: await listen(proxy.server) };
}
const post = (url, body) => fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } });

test('balances API requests round-robin across ready replicas', async () => {
  const a = await replica('a'), b = await replica('b');
  const proxy = await proxyFor([a.url, b.url]);
  const names = [];
  for (let i = 0; i < 4; i++) names.push((await (await fetch(`${proxy.url}/api/ping`)).json()).name);
  assert.deepEqual(names.sort(), ['a', 'a', 'b', 'b']);
});

test('retries a refused connection on another replica exactly once', async () => {
  const dead = createServer(); const deadUrl = await listen(dead);
  const b = await replica('b');
  const proxy = await proxyFor([deadUrl, b.url]);
  proxy.state[0].ready = true; // stale readiness: the replica died after the last probe
  await new Promise(resolve => dead.close(resolve));
  for (let i = 0; i < 2; i++) assert.equal((await (await post(`${proxy.url}/api/mutate`, `{"n":${i}}`)).json()).name, 'b');
  assert.deepEqual(b.seen.map(r => r.body), ['{"n":0}', '{"n":1}']);
});

test('retries a draining replica only when it declares the request not processed', async () => {
  const draining = await replica('draining', (req, res) => {
    if (req.url === '/api/health/ready') return false;
    res.writeHead(503, { 'x-portfolio-pilot-not-processed': 'draining', 'content-type': 'application/json' }); res.end('{}'); return true;
  });
  const b = await replica('b');
  const proxy = await proxyFor([draining.url, b.url]);
  proxy.state.forEach(s => { s.ready = true; });
  const response = await post(`${proxy.url}/api/conversations/x/runs`, '{"content":"hi"}');
  assert.equal(response.status, 200);
  assert.equal(draining.seen.length, 0); assert.equal(b.seen.length, 1);
});

test('never replays a request whose connection reset after it was sent', async () => {
  let received = 0;
  const crashing = await replica('crash', (req, res) => { received++; res.socket.destroy(); return true; });
  const b = await replica('b');
  const proxy = await proxyFor([crashing.url, b.url]);
  proxy.state[1].ready = false; // force the first attempt onto the crashing replica
  const response = await post(`${proxy.url}/api/portfolios/p/transactions`, '{"quantity":"1"}');
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /Refresh to check/);
  assert.equal(received, 1); assert.equal(b.seen.length, 0);
});

test('streams server-sent events without buffering and aborts upstream on client disconnect', async () => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const sse = createServer((req, res) => {
    if (req.url === '/api/health/ready') { res.writeHead(200); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('id: c1\ndata: {}\n\n');
    res.on('close', () => upstreamClosed());
  });
  const proxy = await proxyFor([await listen(sse)]);
  const controller = new AbortController();
  const response = await fetch(`${proxy.url}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /id: c1/);
  controller.abort();
  await closed;
});

test('serves the SPA with fallback and rejects path traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pp-proxy-'));
  closers.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<html>app</html>'); await writeFile(join(dir, 'app.js'), 'ok');
  const proxy = await proxyFor([(await replica('a')).url], { staticDir: dir });
  assert.equal(await (await fetch(`${proxy.url}/portfolios/123`)).text(), '<html>app</html>');
  assert.equal(await (await fetch(`${proxy.url}/app.js`)).text(), 'ok');
  // Raw path: fetch would normalize dot segments before they reach the proxy.
  const status = await new Promise((resolve, reject) => request(`${proxy.url}/..%2f..%2fsecret`, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end());
  assert.equal(status, 400);
});

test('test-only pinning holds a session on one replica, names it, and falls back when it is down', async () => {
  const a = await replica('a'), b = await replica('b');
  const plain = await proxyFor([a.url, b.url]);
  const unpinned = await fetch(`${plain.url}/api/ping`, { headers: { cookie: 'pp-upstream=1' } });
  assert.equal(unpinned.headers.get('x-pp-upstream'), null, 'ordinary proxies ignore the cookie and add no header');
  await unpinned.arrayBuffer();
  const proxy = await proxyFor([a.url, b.url], { pinCookie: 'pp-upstream' });
  for (const [index, name] of [['0', 'a'], ['1', 'b']]) {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${proxy.url}/api/ping`, { headers: { cookie: `session=x; pp-upstream=${index}` } });
      assert.equal(response.headers.get('x-pp-upstream'), index);
      assert.equal((await response.json()).name, name);
    }
  }
  proxy.state[1].ready = false;
  const fallback = await fetch(`${proxy.url}/api/ping`, { headers: { cookie: 'pp-upstream=1' } });
  assert.equal(fallback.headers.get('x-pp-upstream'), '0');
  assert.equal((await fallback.json()).name, 'a');
});
