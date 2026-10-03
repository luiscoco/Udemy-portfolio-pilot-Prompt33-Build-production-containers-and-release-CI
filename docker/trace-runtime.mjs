// Build-time runtime packager (milestone 33). Uses @vercel/nft, the file tracer behind Next.js output
// tracing, to copy ONLY the files a set of Node entry points can load into an output tree.
//
// Why not `npm ci --omit=dev`: in this workspace the lockfile marks typescript, vite, vitest and the
// prisma CLI `devOptional` (optional peers of runtime packages), so npm keeps them; omitting optional
// dependencies as well would drop the Claude Agent SDK's native CLI. Tracing is exact instead.
//
//   node trace-runtime.mjs --base /src --out /out --entry apps/worker/dist/index.js [--entry ...]
//        [--include packages/agent/runtime] [--ignore node_modules/next/] [--sdk-native] [--skip-existing]
//
// --sdk-native adds the platform package the SDK resolves dynamically at run time
// (`@anthropic-ai/claude-agent-sdk-linux-<arch>[-musl]/claude`), which no static tracer can see.
// --skip-existing merges into an existing tree (the Next.js standalone output) without overwriting.
// --ignore <prefix> stops tracing below a path that another trace already owns (Next's server trace).
import { nodeFileTrace } from '@vercel/nft';
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

const args = { entry: [], include: [], ignore: [] };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--base' || flag === '--out') args[flag.slice(2)] = resolve(process.argv[++i]);
  else if (flag === '--entry' || flag === '--include' || flag === '--ignore') args[flag.slice(2)].push(process.argv[++i]);
  else if (flag === '--sdk-native' || flag === '--skip-existing') args[flag.slice(2)] = true;
  else throw new Error(`Unknown argument ${flag}`);
}
if (!args.base || !args.out || !args.entry.length) throw new Error('--base, --out and at least one --entry are required');
const base = args.base;

// Never ship build-only or developer metadata, even when a traced package lists it.
const DROP = [/\.d\.[cm]?ts$/, /\.map$/, /\.tsbuildinfo$/, /(^|\/)\.env(\.|$)/, /(^|\/)(AGENTS|CLAUDE)\.md$/, /(^|\/)\.(claude|codex|agents)(\/|$)/];
const rel = path => relative(base, path).split(sep).join('/');

const { fileList, warnings } = await nodeFileTrace(args.entry.map(entry => join(base, entry)), { base, processCwd: base,
  ignore: path => args.ignore.some(prefix => path.split(sep).join('/').startsWith(prefix)) });
const files = new Set(fileList);

async function addTree(path) {
  const info = await lstat(path);
  if (info.isDirectory()) { for (const name of await readdir(path)) await addTree(join(path, name)); }
  else files.add(rel(path));
}
for (const include of args.include) await addTree(join(base, include));

if (args['sdk-native']) {
  // Same resolution as the SDK: from its entry module, glibc package unless the C library is musl.
  const owner = args.entry.map(entry => join(base, entry))[0];
  const sdkEntry = createRequire(owner).resolve('@anthropic-ai/claude-agent-sdk');
  const musl = process.platform === 'linux' && process.report.getReport().header.glibcVersionRuntime === undefined;
  const binary = createRequire(sdkEntry).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? '-musl' : ''}/claude${process.platform === 'win32' ? '.exe' : ''}`);
  await addTree(dirname(binary));
}

let copied = 0, links = 0, skipped = 0, bytes = 0;
const packages = new Map();
for (const file of [...files].sort()) {
  if (!file || file.startsWith('..') || DROP.some(pattern => pattern.test(file))) continue;
  const source = join(base, file), target = join(args.out, file);
  const info = await lstat(source).catch(() => null);
  if (!info || info.isDirectory()) continue;
  if (args['skip-existing'] && await lstat(target).catch(() => null)) { skipped++; continue; }
  await mkdir(dirname(target), { recursive: true });
  if (info.isSymbolicLink()) { await symlink(await readlink(source), target); links++; continue; }
  await copyFile(source, target);
  await chmod(target, info.mode & 0o755);
  copied++; bytes += info.size;
  const name = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] ?? file.split('/').slice(0, 2).join('/');
  packages.set(name, (packages.get(name) ?? 0) + info.size);
}
const top = [...packages].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, size]) => `${name}=${(size / 1048576).toFixed(1)}MB`);
console.log(JSON.stringify({ entries: args.entry, copied, links, skipped, megabytes: +(bytes / 1048576).toFixed(1), top }));
// Unresolvable optional requires are expected (e.g. pg-native); review the list when dependencies change.
for (const warning of warnings) console.log(`trace warning: ${String(warning.message ?? warning).split('\n')[0]}`);
