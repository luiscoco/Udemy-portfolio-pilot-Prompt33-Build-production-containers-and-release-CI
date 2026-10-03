import { fileURLToPath } from 'node:url';

export default {
  reactStrictMode: true,
  agentRules: false,
  transpilePackages: ['@portfolio-pilot/contracts', '@portfolio-pilot/config'],
  // Milestone 33: `.next/standalone` holds only the traced runtime files (the container image copies it).
  // Tracing starts at the monorepo root so hoisted node_modules and workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  outputFileTracingIncludes: {
    // The Agent SDK resolves its platform CLI package dynamically, which tracing cannot see. Only the
    // package installed for the build platform exists, so a Linux image build gets its Linux binary.
    '/*': ['../../node_modules/@anthropic-ai/claude-agent-sdk-linux-*/**/*']
  }
  // `sharp` arrives through Next's own server trace, which route excludes do not cover; the API image
  // build removes it instead (docker/api.Dockerfile).
};
