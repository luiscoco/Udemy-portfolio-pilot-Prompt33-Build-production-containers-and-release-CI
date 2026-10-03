// Milestone 33 image and browser-asset inspection. Fails if any release image layer, image config or
// build history contains secrets, .env files, agent transcripts/session artifacts or personal agent
// settings, or if the browser bundle references server-only configuration.
//
//   npm run inspect:images                      # images tagged PORTFOLIO_PILOT_TAG (default "local")
//   npm run inspect:images -- --tag ci --json report.json
//   npm run inspect:images -- --images some-image:tag[,other:tag]
//
// Every layer is read from `docker save`, so a file added in one layer and deleted in a later one is
// still found (it still ships in the image). Besides generic secret formats, the scan looks for the
// literal values in the developer's local .env files and secret-like environment variables, without
// ever printing them.
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const tag = option('--tag') ?? process.env.PORTFOLIO_PILOT_TAG ?? 'local';
const images = option('--images')?.split(',') ?? ['web', 'api', 'worker', 'migrate'].map(name => `portfolio-pilot-${name}:${tag}`);

// ------------------------------------------------------------------ rules
const FORBIDDEN_PATHS = [
  [/(^|\/)\.env(\.[^/]*)?$/, 'dotenv file'],
  [/(^|\/)\.(claude|codex|agents|claude-agent-sdk)(\/|$)/, 'personal or project agent settings'],
  [/(^|\/)\.claude\.json$/, 'agent CLI state'],
  [/(^|\/)(CLAUDE|AGENTS)\.md$/, 'agent instruction file'],
  [/(^|\/)sdk-transcripts(\/|$)|\.transcript\.jsonl$/, 'agent transcript'],
  [/(^|\/)projects\/[^/]+\/[0-9a-f-]{36}\.jsonl$/, 'Claude Code session transcript'],
  [/(^|\/)session-artifacts\/./, 'session artifact content'],
  [/(^|\/)\.local\//, 'local workspace state'],
  [/(^|\/)\.git(\/|$)/, 'git metadata'],
  [/(^|\/)\.npm\/_cacache\//, 'npm cache'],
  [/(^|\/)(test-results|playwright-report|coverage)\//, 'test output'],
  [/(^|\/)id_(rsa|ecdsa|ed25519)$/, 'SSH private key'],
  [/(^|\/)\.(vscode|idea)\//, 'editor settings']
];
// Shapes of real credentials, not mentions: code that DETECTS keys (PEM header strings in Next, npm docs,
// the Claude CLI) must not match, and random runs inside binary or base64 data are bounded out.
const SECRET_CONTENT = [
  [/sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{40,}/, 'Anthropic API key'],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{40,}\r?\n){3,}/, 'private key'],
  [/(?<![A-Za-z0-9/+])AKIA[0-9A-Z]{16}(?![A-Za-z0-9/+])/, 'AWS access key'],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  [/:_(?:authToken|auth|password)\s*=\s*[^\s$][^\s]{8,}/, 'npm registry credential'],
  [/AccountKey=[A-Za-z0-9+/]{60,}={0,2}/, 'Azure storage account key'],
  [/[?&]sig=[A-Za-z0-9%]{40,}/, 'SAS signature'],
  [/xox[abprs]-[A-Za-z0-9-]{20,}/, 'Slack token']
];
// Browser bundles must not mention server configuration or server-only packages.
const BROWSER_FORBIDDEN = [/DATABASE_URL/, /REDIS_URL/, /ANTHROPIC/, /AUTH_SECRET/, /ENTRA_CLIENT_SECRET/, /ALPACA_API_(KEY|SECRET)/,
  /postgres(ql)?:\/\//, /rediss?:\/\//, /@prisma\//, /claude-agent-sdk/, /RESEARCH_MCP_TOKEN/, /PORTFOLIO_ADMIN_TOKEN/, /sourceMappingURL/];

// Literal local secret values (never printed): .env files in the repository and secret-like variables.
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|CONNECTION_STRING|DATABASE_URL)/i;
// The committed local example password (compose.yaml, .env.example) is public by design, not a secret.
const PUBLIC_LOCAL_VALUES = new Set(['local_only_change_me', 'mock', 'true', 'false']);
const literals = new Map();
function addLiteral(source, name, value) {
  const trimmed = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (trimmed.length >= 12 && !PUBLIC_LOCAL_VALUES.has(trimmed) && !trimmed.includes('local_only_change_me')) literals.set(trimmed, `${name} from ${source}`);
}
for (const file of ['.env', 'apps/api/.env', 'apps/api/.env.local', 'apps/worker/.env', 'apps/web/.env', 'apps/web/.env.local', 'packages/db/.env']) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && SECRET_NAME.test(match[1])) addLiteral(file, match[1], match[2]);
  }
}
for (const [name, value] of Object.entries(process.env)) if (SECRET_NAME.test(name) && !/^(npm_|GITHUB_ACTIONS)/.test(name)) addLiteral('environment', name, value);

// --self-test: prove each rule fires. Builds a throwaway canary image on top of the first image with
// planted violations (one in a layer that a later layer deletes), scans ONLY the canary, and passes
// when every planted violation is reported.
const selfTest = argv.includes('--self-test');
const canary = { image: `portfolio-pilot-inspect-canary:${Date.now()}`, literal: `canary-${randomBytes(24).toString('hex')}` };
if (selfTest) {
  addLiteral('self-test', 'CANARY_SECRET', canary.literal);
  const base = images[0], dir = mkdtempSync(join(tmpdir(), 'pp-canary-'));
  const fakeKey = `sk-ant-api03-${randomBytes(60).toString('base64url')}`;
  writeFileSync(join(dir, 'Dockerfile'), [`FROM ${base}`, 'USER root',
    `RUN mkdir -p /app/.claude /var/lib/portfolio-pilot/session-artifacts/sessions /var/lib/portfolio-pilot/agent-workspace/projects/-app /usr/share/nginx/html/assets \\`,
    ` && echo '{}' > /var/lib/portfolio-pilot/agent-workspace/projects/-app/${randomUUID()}.jsonl \\`,
    ` && printf 'ANTHROPIC_API_KEY=${fakeKey}\\n' > /app/.env \\`,
    ` && echo '{}' > /app/.claude/settings.json \\`,
    ` && echo '{}' > /var/lib/portfolio-pilot/session-artifacts/sessions/turn.jsonl \\`,
    ` && echo '{"mappings":""}' > /usr/share/nginx/html/assets/canary.js.map \\`,
    ` && echo 'const config = { url: "${canary.literal}" };' > /usr/share/nginx/html/assets/canary.js`,
    '# Deleted again: it still ships in the previous layer.', 'RUN rm -f /app/.env', 'USER 65534', ''].join('\n'));
  const built = spawnSync('docker', ['build', '-q', '-t', canary.image, dir], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  if (built.status !== 0) throw new Error(`canary build failed: ${built.stderr}`);
  images.splice(0, images.length, canary.image);
}
const literalList = [...literals.keys()];

// ------------------------------------------------------------------ minimal streaming tar reader
function octal(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  if (field[0] & 0x80) { let value = 0; for (let i = 1; i < field.length; i++) value = value * 256 + field[i]; return value; }
  const text = field.toString('latin1').replace(/\0.*$/, '').trim();
  return text ? parseInt(text, 8) : 0;
}
function parsePax(text) {
  const out = {};
  for (let at = 0; at < text.length;) {
    const space = text.indexOf(' ', at), length = Number(text.slice(at, space));
    if (!length) break;
    const record = text.slice(space + 1, at + length - 1), eq = record.indexOf('=');
    out[record.slice(0, eq)] = record.slice(eq + 1); at += length;
  }
  return out;
}
/** Calls onEntry({ path, type, size }) and onData(entry, chunk) for regular files. */
function tarReader(onEntry, onData) {
  let pending = Buffer.alloc(0), entry = null, remaining = 0, padding = 0, longName = null, pax = null, meta = null;
  return chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (remaining > 0) {
        if (!pending.length) return;
        const take = Math.min(remaining, pending.length), part = pending.subarray(0, take);
        if (meta) meta.push(Buffer.from(part)); else if (entry?.type === 'file') onData(entry, part);
        pending = pending.subarray(take); remaining -= take;
        if (remaining > 0) return;
        if (meta) {
          const text = Buffer.concat(meta).toString('utf8');
          if (meta.kind === 'L') longName = text.replace(/\0.*$/s, ''); else if (meta.kind === 'x') pax = parsePax(text);
          meta = null;
        }
        continue;
      }
      if (padding > 0) { const skip = Math.min(padding, pending.length); pending = pending.subarray(skip); padding -= skip; if (padding > 0) return; continue; }
      if (pending.length < 512) return;
      const header = pending.subarray(0, 512); pending = pending.subarray(512);
      if (header.every(byte => byte === 0)) { entry = null; continue; }
      const size = octal(header, 124, 12), flag = String.fromCharCode(header[156] || 48);
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
      let path = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      if (prefix && header.subarray(257, 262).toString('latin1') === 'ustar') path = `${prefix}/${path}`;
      remaining = size; padding = (512 - (size % 512)) % 512;
      if (flag === 'L' || flag === 'x' || flag === 'g') { meta = []; meta.kind = flag; entry = null; continue; }
      if (longName) { path = longName; longName = null; }
      if (pax?.path) path = pax.path;
      pax = null;
      const type = flag === '0' || flag === '7' ? 'file' : flag === '5' ? 'dir' : flag === '2' ? 'symlink' : flag === '1' ? 'hardlink' : 'other';
      entry = { path: path.replace(/^\.?\//, ''), type, size };
      onEntry(entry);
    }
  };
}
/** Outer `docker save` archive: uncompressed, so record every member's offset. */
function outerIndex(file) {
  const fd = openSync(file, 'r'), header = Buffer.alloc(512), members = new Map();
  let offset = 0, longName = null;
  try {
    for (;;) {
      if (readSync(fd, header, 0, 512, offset) < 512 || header.every(byte => byte === 0)) break;
      const size = octal(header, 124, 12), flag = String.fromCharCode(header[156] || 48);
      let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
      if (prefix) name = `${prefix}/${name}`;
      if (flag === 'L') { const body = Buffer.alloc(size); readSync(fd, body, 0, size, offset + 512); longName = body.toString('utf8').replace(/\0.*$/s, ''); }
      else { members.set(longName ?? name, { start: offset + 512, size }); longName = null; }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  } finally { closeSync(fd); }
  return members;
}
function readMember(file, member) { const fd = openSync(file, 'r'), body = Buffer.alloc(member.size); try { readSync(fd, body, 0, member.size, member.start); } finally { closeSync(fd); } return body; }

// ------------------------------------------------------------------ scanning
const findings = [];
const summary = {};
function scannerFor(image, layer) {
  const tail = new Map();
  const browser = image.includes('-web:') || selfTest;
  return {
    entry(entry) {
      summary[image].entries++;
      for (const [pattern, why] of FORBIDDEN_PATHS) {
        if (pattern.test(entry.path) && !(entry.type === 'dir' && why === 'session artifact content')) findings.push({ image, layer, path: entry.path, problem: why });
      }
      if (browser && entry.type === 'file' && /^usr\/share\/nginx\/html\/.+\.map$/.test(entry.path)) findings.push({ image, layer, path: entry.path, problem: 'source map in browser assets' });
    },
    data(entry, chunk) {
      // Overlap chunks so a value split across two reads is still matched.
      const previous = tail.get(entry) ?? '';
      const text = previous + chunk.toString('latin1');
      tail.set(entry, text.slice(-512));
      for (const [pattern, why] of SECRET_CONTENT) if (pattern.test(text)) report(entry, why);
      for (const value of literalList) if (text.includes(value)) report(entry, `local secret value (${literals.get(value)})`);
      if (browser && /^usr\/share\/nginx\/html\//.test(entry.path)) {
        summary[image].browserBytes += chunk.length;
        for (const pattern of BROWSER_FORBIDDEN) if (pattern.test(text)) report(entry, `browser asset references ${pattern.source}`);
      }
    }
  };
  function report(entry, problem) {
    if (!findings.some(f => f.image === image && f.path === entry.path && f.problem === problem)) findings.push({ image, layer, path: entry.path, problem });
  }
}
async function scanLayer(file, member, scanner) {
  const head = readMember(file, { start: member.start, size: Math.min(4, member.size) });
  const source = createReadStream(file, { start: member.start, end: member.start + member.size - 1, highWaterMark: 1 << 20 });
  const stream = head[0] === 0x1f && head[1] === 0x8b ? source.pipe(createGunzip())
    : head.readUInt32LE(0) === 0xfd2fb528 ? source.pipe(createZstdDecompress()) : source;
  const feed = tarReader(entry => scanner.entry(entry), (entry, chunk) => scanner.data(entry, chunk));
  for await (const chunk of stream) feed(chunk);
}
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const work = mkdtempSync(join(tmpdir(), 'pp-image-inspect-'));
try {
  for (const image of images) {
    summary[image] = { layers: 0, entries: 0, browserBytes: 0 };
    const [info] = JSON.parse(docker(['image', 'inspect', image]));
    summary[image].sizeMB = Math.round(info.Size / 1048576);
    summary[image].user = info.Config.User || '(root)';
    summary[image].platform = `${info.Os}/${info.Architecture}`;
    if (!info.Config.User || /^(0|root)(:|$)/.test(info.Config.User)) findings.push({ image, path: '(config)', problem: 'image runs as root' });
    for (const variable of info.Config.Env ?? []) {
      const [name, ...rest] = variable.split('='), value = rest.join('=');
      if (SECRET_NAME.test(name) && value) findings.push({ image, path: `(config env ${name})`, problem: 'secret-like variable has a baked value' });
      for (const [pattern, why] of SECRET_CONTENT) if (pattern.test(value)) findings.push({ image, path: `(config env ${name})`, problem: why });
    }
    const history = docker(['history', '--no-trunc', '--format', '{{.CreatedBy}}', image]);
    for (const [pattern, why] of SECRET_CONTENT) if (pattern.test(history)) findings.push({ image, path: '(build history)', problem: why });
    for (const value of literalList) if (history.includes(value)) findings.push({ image, path: '(build history)', problem: `local secret value (${literals.get(value)})` });

    const archive = join(work, 'image.tar');
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['save', '-o', archive, image], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', d => { stderr += d; });
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`docker save ${image}: ${stderr}`)));
    });
    const members = outerIndex(archive);
    const manifest = JSON.parse(readMember(archive, members.get('manifest.json')).toString('utf8'));
    for (const layer of manifest[0].Layers) {
      summary[image].layers++;
      await scanLayer(archive, members.get(layer), scannerFor(image, layer.slice(-19)));
    }
    rmSync(archive, { force: true });
    console.log(`scanned ${image}: ${JSON.stringify(summary[image])}`);
  }
} finally { rmSync(work, { recursive: true, force: true }); }

const report = { tag, images: summary, localSecretValuesChecked: literalList.length, findings };
if (option('--json')) writeFileSync(option('--json'), JSON.stringify(report, null, 2));
if (selfTest) {
  spawnSync('docker', ['image', 'rm', '-f', canary.image], { encoding: 'utf8' });
  const expected = ['dotenv file', 'Anthropic API key', 'personal or project agent settings', 'session artifact content', 'Claude Code session transcript',
    'source map in browser assets', 'local secret value (CANARY_SECRET from self-test)'];
  const missing = expected.filter(problem => !findings.some(finding => finding.problem === problem));
  for (const finding of findings) console.log(` - detected ${finding.path}: ${finding.problem}`);
  if (missing.length) { console.error(`SELF-TEST FAIL: not detected: ${missing.join('; ')}`); process.exitCode = 1; }
  else console.log(`SELF-TEST PASS: all ${expected.length} planted violations detected, including a file deleted in a later layer.`);
} else if (findings.length) {
  console.error(`FAIL: ${findings.length} finding(s)`);
  for (const finding of findings.slice(0, 50)) console.error(` - ${finding.image} ${finding.path}: ${finding.problem}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: ${images.length} images, no secrets, .env files, transcripts, session artifacts or agent settings; ${literalList.length} local secret value(s) checked.`);
}
