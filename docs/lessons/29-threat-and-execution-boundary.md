# 29. Harden the application and execution boundary

## What works

Application authorization blocks hostile model-selected calls independently of refusal behavior.
The fixture in `tests/fixtures/adversarial-news.json` contains article instructions to read another
user's portfolio, invoke shell/file tools, steal credentials, fetch metadata, and bypass approval.
Tests deliberately issue those actions. Owner-bound repository reads, strict tool input schemas,
exact durable approvals and the runtime's tool policy enforce denial. News text remains untrusted
evidence; no attempt is made to prove safety by asserting that a mock model says “no”.

Concrete fixes: quote reads recheck ownership at use; provider endpoints are explicitly allowlisted;
Alpaca rejects redirects and stops oversized streaming responses before buffering them in full;
source links reject IP/local/internal destinations and unsafe schemes/credentials/ports; alert
tools enforce cancellation and output bounds; every tool path bounds arguments and generic errors;
the complete MCP result envelope (including duplicated text/structured JSON) is capped; policy hooks
limit run calls to 64. Mutation bodies across portfolio/watchlist/alert/recommendation/chat routes
now have a 10 KB/10 second bound, including chunked uploads. Metadata audit logs redact sensitive
fields and credential-bearing strings; raw fixture CLI errors are removed. Blob listing/token
responses and listing continuation are bounded. No article URL fetcher was added.

## Changed files

- `packages/contracts/src/chat.ts`; `apps/web/src/lib/news-content.ts`: shared display-link policy.
- `packages/providers/src/server.ts`, `test/alpaca.test.ts`: endpoint, input and streaming limits.
- `packages/db/src/agent-tool-reads.ts`: ownership recheck on direct/latest quote retrieval.
- `packages/agent/src/tools/{schemas,portfolio-tools}.ts`, `approval-tools.ts`, `research-mcp.ts`,
  `policy-hooks.ts`, `bounded-response.ts`, `azure-session-artifacts.ts`: tool/response bounds,
  sanitized errors/logs, fixed Blob origin and bounded pagination.
- `packages/agent/src/{index,application-skills}.ts`: truthful workspace comment and new runtime
  policy fingerprint; older incompatible checkpoints reseed.
- `packages/observability/src/{index,redaction,redaction.test}.ts`, `packages/agent/package.json`,
  `package-lock.json`: internal metadata redaction dependency and tests; no third-party upgrade.
- `apps/api/lib/{request-body,request-body.test,portfolio-http,chat}.ts` and eight mutation route
  files under `app/api/{portfolios,watchlist,alerts/rules,recommendations}`: bounded body parser.
- `apps/worker/src/inject-fixture.ts`: generic safe errors.
- `tests/fixtures/adversarial-news.json`, `packages/agent/test/security.test.ts`,
  `apps/web/src/security.test.tsx`: shared hostile fixture and direct-action/render regression tests.
- Existing agent `tools`, `skills-policy`, `session-artifacts`, `sessions-analysis` tests; API
  `agent-tools`, `approvals`, `portfolio` integration tests: regression coverage and exact
  allowlisting of the isolated milestone-29 verification database.
- ADR 0022, ADR 0010 clarification, ADR index, versions notes and project state. No files removed.

## Check results and reproduction

The installed npm wrapper reports NVM4306. This host used its already installed Node/npm CLI
directly; no nvm settings were changed. Equivalent commands on a working npm installation are
`npm ci --ignore-scripts --offline --cache .npm-cache`, `npm run typecheck`, `npm run build`.
On this host:

```powershell
$nodeExe='C:/Users/luisc/AppData/Local/Author Software/nvm/installs/v24.21.0/node.exe'
$npmCli='C:/Users/luisc/AppData/Local/Author Software/nvm/installs/v24.21.0/node_modules/npm/bin/npm-cli.js'
& $nodeExe $npmCli ci --ignore-scripts --offline --cache .npm-cache
& $nodeExe $npmCli run typecheck
& $nodeExe $npmCli run build
node node_modules/vitest/vitest.mjs run --root packages/agent
node node_modules/vitest/vitest.mjs run --root packages/providers
node node_modules/vitest/vitest.mjs run --root packages/observability
node node_modules/vitest/vitest.mjs run --root apps/web src
node node_modules/vitest/vitest.mjs run --root apps/api --exclude '**/*.integration.test.ts'
node scripts/check-browser-boundary.mjs
```

Final local results: typecheck passed across all workspaces; full web/API/worker production build
passed (existing Vite directive/chunk-size and Next instrumentation Edge warnings). Final agent
compile and API typecheck passed after complete-envelope limits. Agent **146 passed / 4 skipped**,
providers **19 passed**, observability **2 passed**, web **31 passed**, API unit **34 passed**.
The agent suite includes actual credential-free SDK discovery of only managed skills from a dirty
caller environment. Optional live/process fixture suites are skipped by their prerequisites.
Browser dependency graph passed. No real provider/Claude/Blob credentials were used.

For real repository/HTTP acceptance, this run created `portfolio_m29_verify` on the existing
loopback test PostgreSQL and applied all 18 existing migrations. Create it only if absent:

```powershell
docker exec portfolio-pilot-m06-verify createdb -U portfolio_local portfolio_m29_verify
$env:DATABASE_URL='postgresql://portfolio_local:local_only_change_me@127.0.0.1:5546/portfolio_m29_verify'
& $nodeExe $npmCli run migrate:deploy --workspace=@portfolio-pilot/db
$env:DATA_MODE='mock'
$env:AGENT_TOOLS_TEST_DATABASE_URL=$env:DATABASE_URL
node node_modules/vitest/vitest.mjs run --root apps/api lib/agent-tools.integration.test.ts
$env:APPROVAL_TEST_DATABASE_URL=$env:DATABASE_URL
node node_modules/vitest/vitest.mjs run --root apps/api lib/approvals.integration.test.ts
$env:PORTFOLIO_TEST_DATABASE_URL=$env:DATABASE_URL
node node_modules/vitest/vitest.mjs run --root apps/api lib/portfolio.integration.test.ts
```

Final PostgreSQL results: owner-bound tools **11/11**, durable approvals **13/13**, portfolio and
watchlist HTTP **10/10**. Direct quote reads reject foreign IDs and reject access after watchlist
removal. Injected news cannot open another owner's portfolio/article. Approval tests verify exact
arguments, foreign approvals, expiry, rejection, cancellation and one-time consumption.

Earlier failures were corrected and rerun: a timeout/cancel race in the new reader; old assertions
expecting raw validation messages; the multi-byte detail test now expects fail-closed when the
complete duplicated envelope is too large. An overbroad Vitest web invocation mistakenly collected
Playwright specs; the workspace's `src` filter passes. Approval execution tests failed on retained
`portfolio_m27_verify` but pass on a fresh database; do not use retained fixture state as a clean
acceptance baseline. Portfolio acceptance first rejected the new database name and then lacked
`DATA_MODE`; the exact database allowlist and documented mock configuration resolve these checks.
Initial sandboxed Prisma cache and Docker access failed; approved local verification access
completed them. No final required local check remains blocked.

## Demonstration

Run the fixture tests above to demonstrate malicious actions are denied without using a model.
For the UI, configure local mock/demo settings per milestone 28, run `npm run dev`, and run the
agent/outbox worker roles. Sign in as Alice at `http://127.0.0.1:5173/assistant`, select Growth,
ask about holdings/news, then sign in as Bob and verify Alice's portfolio ID is inaccessible.
On News, article markup is displayed as text; unsafe source URLs show “Source link unavailable”.
The render fixture test supplies unsafe URLs even as cited evidence and verifies no clickable
link/image is emitted. There is no production endpoint to inject adversarial articles.

## Remaining limitations and exercise

Read [ADR 0022](../decisions/0022-threat-and-execution-boundary.md). A working directory is not an
OS sandbox. The trusted worker/SDK/MCP executable shares an OS identity, credentials and process
boundary across users. Application checks constrain model-selected operations; they do not contain
compromised host code or guarantee factual/injection-resistant answers. Public links may lead to
hostile publishers; link validation does not make a generic fetcher safe against DNS rebinding.
User article URLs never become server fetch targets. Live services and a new interactive browser
session were not verified in this slice; DOM rendering, real route handlers and builds were checked.

Per-run container/Job isolation is **design only**, for expanded privileged tools. It needs a trusted
tool/credential gateway, current-attempt capabilities, default-deny egress, non-root containers,
minimum service permissions and OS resource limits. These are later deployment requirements,
not delivered infrastructure. Milestone 30 owns global queue/concurrency/recovery controls.

Exercise: add a private IPv6 or credential-exfiltration trap, deliberately issue its requested tool
call, and identify the deterministic enforcement point. Never assert that a model refusal proves
authorization. Never enable shell/file tools based on `cwd` separation alone.
