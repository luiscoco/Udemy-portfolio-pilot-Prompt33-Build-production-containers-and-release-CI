// Milestone 33 in-container SDK probe (verification only; bind-mounted, never baked into an image).
// Runs the pinned Agent SDK's bundled Claude Code CLI inside a release image, as the image's non-root
// user on a read-only root filesystem, against a deterministic LOCAL HTTP model fixture. No API key,
// no paid endpoint. It proves the native binary, its shared libraries and its writable paths work.
//
// The options mirror the application's live adapter (packages/agent/src/index.ts): isolated
// CLAUDE_CONFIG_DIR/cwd workspace, no setting sources, no built-in tools, dontAsk, persisted session.
//   docker run --rm --read-only --tmpfs /tmp --tmpfs /var/lib/portfolio-pilot/agent-workspace:uid=10001,gid=10001,mode=0700 \
//     -v "$PWD/docker/verify:/verify:ro" --entrypoint node <image> /verify/sdk-fixture-probe.mjs <dir that resolves the SDK>
import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const from = process.argv[2];
const workspace = process.env.AGENT_WORKSPACE_DIR;
if (!from || !workspace) throw new Error('Usage: sdk-fixture-probe.mjs <resolution dir>; AGENT_WORKSPACE_DIR must be set');
const { query } = await import(pathToFileURL(createRequire(join(from, 'noop.js')).resolve('@anthropic-ai/claude-agent-sdk')).href);

const requests = [];
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  if (!request.url?.startsWith('/v1/messages')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ model: body.model, stream: Boolean(body.stream), tools: body.tools?.length ?? 0 });
  const text = 'Container fixture answer.';
  const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 4 } };
  if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  frame('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  frame('content_block_stop', { type: 'content_block_stop', index: 0 });
  frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  frame('message_stop', { type: 'message_stop' }); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const abortController = new AbortController(), timer = setTimeout(() => abortController.abort(), 60000);
const runtime = query({ prompt: 'Say something.', options: {
  model: 'claude-sonnet-4-6', cwd: workspace, settingSources: [], tools: [], mcpServers: {}, strictMcpConfig: true,
  permissionMode: 'dontAsk', maxTurns: 1, maxBudgetUsd: 0.01, persistSession: true, abortController,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CLAUDE_CONFIG_DIR: workspace, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ANTHROPIC_API_KEY: 'local-http-fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } } });
let result, stderr = '';
try { for await (const message of runtime) if (message.type === 'result') result = message; }
catch (error) { stderr = String(error?.message ?? error); }
finally { clearTimeout(timer); runtime.close(); server.close(); }
async function list(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(prefix, entry.name);
    out.push(entry.isDirectory() ? `${path}/` : path);
    if (entry.isDirectory()) out.push(...await list(join(dir, entry.name), path));
  }
  return out;
}
const written = await list(workspace);
const ok = result?.subtype === 'success' && requests.length > 0 && written.some(path => path.endsWith('.jsonl'));
console.log(JSON.stringify({ ok, uid: process.getuid(), result: result?.subtype ?? null, answer: result?.result ?? null, requests, workspaceFiles: written.slice(0, 20), error: stderr || undefined }));
process.exit(ok ? 0 : 1);
