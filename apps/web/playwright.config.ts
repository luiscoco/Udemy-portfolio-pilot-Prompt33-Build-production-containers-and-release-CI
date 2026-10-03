import { defineConfig } from '@playwright/test';

// `npm run test:browser` (repository root) starts the full topology and sets E2E_BASE_URL to its
// single origin. Running Playwright directly keeps the original Vite dev-server default.
export default defineConfig({
  testDir: './e2e',
  testIgnore: ['support/**'],
  retries: 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173', channel: 'chrome' },
  reporter: 'list'
});
