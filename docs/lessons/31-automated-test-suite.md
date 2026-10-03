# 31. Build a meaningful automated test suite

Current results and the invariant-to-test map: [verification report](../verification-report.md).

## What works

- **Three documented commands.** `npm run test:unit` (no infrastructure), `npm run test:integration`
  (disposable PostgreSQL + Redis, real worker processes) and `npm run test:browser` (Chrome against
  the real two-replica topology). Each builds what it needs, prints a summary with every skipped test
  by name, and exits 0/1/2 (pass / failure / missing prerequisite). A suite that runs zero tests
  counts as a failure.
- **Isolation by construction.** Before this milestone, integration suites needed 19 different
  variables and each hard-coded its own `portfolio_mNN_verify` database. Browser specs each needed a
  hand-started server configuration, and one integration suite and one spec wrote to the shared
  development Redis on port 6379. Now the harness starts throwaway containers, migrates a template
  once, and gives every suite file (and every browser phase) its own cloned database and flushed Redis
  logical database. `tests/support/disposable-database.ts` makes every suite refuse anything else.
- **Browser topology = production shape.** Two `apps/api/server.mjs` replicas behind the local
  proxy (one origin serving the React build), two mock agent workers, and one outbox worker, which
  also runs research and alerts. Phases exist only where a spec needs different server settings:
  `main`, `limits` (lesson 26 budget settings) and `outages` (stops and restarts the run's own
  containers).
- **New tests where coverage was thin.**
  - `fanout.spec.ts`: two-API fan-out, with replica placement verified, not assumed.
  - `article-recommendation.spec.ts`: new article to recommendation through background processes only.
  - `session-expiry.spec.ts`: server-side authentication expiry, with a controlled browser clock.
  - `valuation.property.test.ts`: 600 seeded random ledgers against an independent exact-rational
    model, including deliberately oversold ledgers.
  - A proxy test for the new opt-in replica pinning.

## Teaching points

- **Test outcomes, not implementations.** The fan-out spec never reads Redis or the outbox; it
  checks what each user's browser shows and which replica served it. The property test's reference
  model shares no code with `valuation.ts`; it restates the business rules.
- **Check that a test can fail.** The property test passed on its first run, so it was deliberately
  broken (buy fees dropped from cost basis). It failed on seed 1 with the ledger printed, then
  passed again once restored.
- **Whose clock?** On Docker Desktop for Windows the database container clock was measured
  about 0.85 s ahead of the host. The product already uses PostgreSQL `clock_timestamp()` for
  outbox backoff and Redis `TIME` for stream retention, so it is consistent. A test that mixes
  host and server time, or that waits between two timing-sensitive steps, is not.
- **Stale tests hide behind gates.** Specs that skip unless a variable is set can silently rot.
  Four of them had: their expectations predated later milestones. Each was corrected toward the
  current, intended behavior, and in one case the product was fixed instead (see below).

## Failures found and how each was resolved

First full runs: integration 126/127 and browser 20/28. None was fixed by accepting wrong
output.

| Failure | Cause | Resolution |
| --- | --- | --- |
| `chat.spec` › Cancel answer: expected text missing | **Product inconsistency.** When cancellation won the race at finalization, `chat-service.ts` wrote a different cancellation sentence from the worker's. | Unified the wording in `packages/db/src/chat-service.ts`; assertion unchanged |
| `outbox.integration` › retries (under parallel load) | The test re-checked "not claimable before the 1 s backoff" only after several slower queries | Moved that check directly after the failing dispatch; same assertion |
| `alerts.spec`, `article-recommendation.spec` timed out | `getByLabel('Watched securities', { exact: true })` never matches: the wrapping label's text includes the option texts | Role locator `getByRole('listbox', { name: 'Watched securities' })` |
| `news-live.spec` | Fixture titles changed in milestone 22; the spec still expected the old wording | Titles now come from `fixtureArticle()` itself |
| `portfolio.spec` final step | Since milestone 15 the portfolio list is seeded from `/api/events/recovery`, so stubbing only `/api/portfolios` with 401 never reached the app | The stub also rejects the recovery read; assertion unchanged |
| `providers.spec` | Default mock interval is 30 s (the spec assumes lesson 11's 5 s), and each replica built its own mock schedule | Harness sets `MOCK_NEWS_INTERVAL_MS=5000` and a shared `MOCK_START_AT` |
| `fanout.spec` (new) answer text | My assumption about the mock's wording for an unscoped conversation | Compares with the persisted answer instead and checks it appears exactly once |
| `session-expiry.spec` (new) | "Alice Demo" also appears on the sign-in button | Asserts that the authenticated-session region is gone |

## Changed files

Created: `scripts/test-unit.mjs`, `scripts/test-integration.mjs`, `scripts/test-browser.mjs`,
`scripts/test-support/{infra,report}.mjs`, `tests/support/disposable-database.ts`,
`apps/web/e2e/support/env.ts`, `apps/web/e2e/{fanout,article-recommendation,session-expiry}.spec.ts`,
`packages/domain/src/valuation.property.test.ts`, `docs/verification-report.md`, this lesson.

Modified:
- `package.json`: the three scripts.
- `scripts/local-proxy.mjs` and its test: opt-in `pinCookie` routing and `x-pp-upstream`.
- `apps/web/playwright.config.ts`: `E2E_BASE_URL`, `support/` ignored, no retries.
- Database guards in the 16 integration suites; the alerts suite now requires
  `ALERT_TEST_REDIS_URL` instead of the shared Redis.
- `outbox.integration.test.ts`: check ordering.
- Existing browser specs: shared environment, origin, Redis and guards, plus the fixes in the table.
- `packages/db/src/chat-service.ts`: cancellation wording.
- `docs/project-state.md`.

No dependency or lockfile changes.

## Reproduction

```powershell
npm ci --ignore-scripts --offline --cache .npm-cache   # if node_modules is missing
npm run test:unit
npm run test:integration          # Docker running, or set TEST_POSTGRES_URL / TEST_REDIS_URL
npm run test:browser              # additionally needs Google Chrome
```

If `prisma migrate deploy` cannot download its schema engine offline, the harness uses
`.cache/prisma/schema-engine.exe` when present, or `PRISMA_SCHEMA_ENGINE_BINARY` (lesson 26).

## Remaining limitations and exercise

- Live Claude, Azure Blob, Alpaca and Entra are not exercised; the four live Vitest tests stay
  gated (verification report lists their variables).
- Browser specs run one at a time; parallelizing them needs per-spec demo users.
- `npm run verify:distributed` stays separate (repeated process kills and container stops).
- Exercise: add a CI job (milestone 33) that sets `TEST_POSTGRES_URL`/`TEST_REDIS_URL` to service
  containers and runs the three commands, and publishes Playwright traces on failure
  (`TEST_BROWSER_TRACE=true`).
