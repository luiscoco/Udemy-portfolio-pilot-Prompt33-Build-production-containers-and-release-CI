// Build-time gate (milestone 33): proves the pinned Claude Agent SDK can find and start its native
// Claude Code CLI on THIS image's platform, without any globally installed developer CLI.
//
// The SDK (sdk.mjs) resolves `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude` relative
// to itself; on glibc Linux it prefers the glibc package. We resolve exactly that path from the
// installed SDK, check the versions match the lockfile pin, and execute `claude --version`.
// Usage: node check-sdk-runtime.mjs <a directory whose node_modules resolution reaches the SDK>
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const from = process.argv[2];
if (!from) throw new Error('Usage: check-sdk-runtime.mjs <resolution directory>');
if (process.platform !== 'linux') throw new Error(`Unsupported image platform ${process.platform}`);
const sdkEntry = createRequire(join(from, 'noop.js')).resolve('@anthropic-ai/claude-agent-sdk');
const sdkDir = dirname(sdkEntry);
const sdk = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
// glibc unless the C library reports otherwise (the same signal the SDK uses).
const musl = process.report.getReport().header.glibcVersionRuntime === undefined;
const nativeName = `@anthropic-ai/claude-agent-sdk-linux-${process.arch}${musl ? '-musl' : ''}`;
const binary = createRequire(sdkEntry).resolve(`${nativeName}/claude`);
const native = JSON.parse(readFileSync(join(dirname(binary), 'package.json'), 'utf8'));
if (native.version !== sdk.version) throw new Error(`Native CLI ${native.version} does not match SDK ${sdk.version}`);
if (!(statSync(binary).mode & 0o111)) throw new Error(`${binary} is not executable`);
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 30000,
  env: { PATH: process.env.PATH, HOME: process.env.TMPDIR ?? '/tmp', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }).trim();
if (!version.startsWith(sdk.claudeCodeVersion)) throw new Error(`CLI reported "${version}", expected ${sdk.claudeCodeVersion}`);
console.log(JSON.stringify({ sdk: sdk.version, claudeCode: sdk.claudeCodeVersion, native: nativeName, binary, version, arch: process.arch, libc: musl ? 'musl' : 'glibc' }));
