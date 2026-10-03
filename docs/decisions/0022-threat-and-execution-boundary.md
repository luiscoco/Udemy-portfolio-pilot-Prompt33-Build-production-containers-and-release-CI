# 0022. Threat and execution trust boundary

- Status: Accepted
- Date: 2026-10-03
- Milestone: 29

## Context

Users, model-generated arguments/answers, news, source URLs and external MCP output are untrusted.
An injected article may induce a model to issue malicious calls. Refusal language and system prompts
are not authorization controls. Milestones 17–28 already implemented owner-bound data ports,
exact durable approvals, run fences, private checkpoints, usage reservations and bounded streams.
This review hardens concrete gaps without expanding runtime privileges.

## Decision

The course runtime remains a constrained tool-only agent on a **shared trusted worker**. A separate
working directory is **not an operating-system sandbox**. It separates runtime configuration and
transcript paths; it does not restrict processes, network access, kernel privileges, the worker's
database credentials, or access to another run's files by compromised application code. All runs
share the worker OS identity. The Node host, installed SDK/CLI, managed skill text, MCP executable,
repositories and artifact-store implementation are trusted code. Their compromise can cross tenants.
We claim application authorization isolation against model-selected calls, not containment against
arbitrary code execution or an SDK/worker exploit.

| Boundary | Implemented enforcement and review result |
| --- | --- |
| Session → API → owner port | Identity is minted from a verified session, not request/model IDs. Portfolio, news, conversations, approvals and SSE remain owner-scoped. Quote retrieval now repeats interest ownership inside `latestQuotes`, including after watchlist removal. |
| Model → application tools | No arbitrary shell/file/web tools. `tools: []`, bare deny rules, strict MCP configuration, and composed pre-tool policy; optional named specialists and two managed instruction skills retain their narrow capabilities. Hooks run before auto-approved tools; handlers enforce strict schemas, owner reads and approvals again. |
| News → prompt | News remains visibly labeled untrusted data. Injection text is preserved as evidence, never executed as code. A malicious model cannot select another account, execute trades, invoke a shell, or bypass exact durable approval. This does not guarantee a correct or injection-free answer. |
| URL → server network | No article fetcher exists; `getNewsArticle` accepts a stored article ID, not a URL. Alpaca accepts only `https://data.alpaca.markets` and two compiled paths. Credentials are attached only after that check. Redirects are rejected, never followed. Blob uses the configured Azure account hostname, HTTPS/default port and no SAS; Entra token host is fixed. Neither article text nor model arguments select these hosts. |
| Untrusted text → browser | React text escaping, deliberately small Markdown (no HTML/images/autolinks), exact recorded evidence matching, shared source-link validation, no credentials or arbitrary ports, no IP literals (including normalized hexadecimal/integer IPv4), no local/internal names. New-tab evidence links use noopener/noreferrer and no-referrer. Public publisher destinations may themselves be hostile; clicking a link is not server fetching. |
| Payload → resources | Alpaca stops while reading at 2,000,000 decompressed bytes; inputs/checkpoints are bounded. Tool input ≤8,000 bytes; output ≤48,000 bytes and configured lower limits, alert reads ≤20 rows. Pre-tool policy permits at most 64 calls per run. Mutation JSON reads ≤10,000 bytes/10 seconds including chunked bodies. Existing turn/time/cost/prompt/answer budgets, specialist limits, durable daily reservations and bounded SSE remain. Blob list pages ≤1 MB, ≤100 pages with repeated-marker rejection; token JSON ≤64 KB. |
| Error/payload → logs | Agent audit logs select metadata fields explicitly, redact sensitive keys/URLs/bearer values, bound nesting and size, omit raw exceptions and prompts. Tools return generic validation/dependency failures. Fixture CLI no longer prints raw errors. Redaction is defense in depth; never pass arbitrary free text or configuration to log functions. |

Source URL validation is a conservative display policy, **not a general SSRF-safe fetch primitive**.
No DNS resolution is needed because user URLs never become server request targets. Do not add a
generic fetcher based only on this validator. Any future URL fetcher must validate every hop, reject
private/link-local/loopback/multicast/metadata destinations in IPv4 and IPv6, pin the validated DNS
result to the connection to prevent rebinding, enforce egress via a proxy, omit credentials, and cap
bytes/time/redirect count. Prefer an exact provider allowlist and rejecting all redirects.

The application runtime policy version changes to `skills-policy-v2-hardened`; incompatible older
SDK checkpoints are summary-reseeded rather than resumed under silently changed policy.

## Optional expanded-tool isolation design — not implemented

Before enabling privileged shell/file tools, run each attempt in a fresh container/Kubernetes Job.
The trusted coordinator keeps PostgreSQL credentials, cross-user session storage and approval
services outside the run container. It issues a short-lived capability bound to owner, run and fence
for an authenticated tool gateway; gateway handlers still recheck ownership/approval, rate limits
and fence validity. A container cannot choose an owner or obtain a broad database credential.

Use a non-root UID, read-only root filesystem, dropped capabilities, no privilege escalation,
RuntimeDefault seccomp, bounded ephemeral workspace, CPU/memory/PID/storage limits, wall-clock
deadline and cleanup TTL. Mount only the current authorized input/checkpoint and versioned managed
instructions. No host filesystem, Docker socket, host networking, developer home or shared transcript
volume. Disable service-account token automount; the run needs no Kubernetes API access. The
coordinator's separate service account has only the namespace Job lifecycle permissions it needs.
Use default-deny network policy plus a validating egress gateway/proxy; model credentials are injected
at that proxy, not exposed to privileged code. A DNS-only allowlist is insufficient. Reject internal
network and metadata access, including through redirects or allowed services acting as proxies.

Restore/publish checkpoints only through the coordinator under the live attempt fence. Cancellation
revokes the capability and terminates the Job; crashes cannot automatically replay mutations.
Validate escape/exfiltration tests before enabling any new tool. Containers share the host kernel;
stronger adversarial workloads may need a sandbox runtime or VM with verified compatibility.
No Job launcher, egress proxy, OS sandbox or per-run container isolation is implemented here.

## Consequences

Milestones 33–35 must use non-root containers, minimum database/cloud/service-account permissions,
restricted pod security contexts, explicit role separation and egress policies. These deployment
controls are requirements for later implementation; no cloud resources or deployment were created.
Global queue/concurrency and recovery controls remain milestone 30. Answer-quality/injection
resilience evaluation remains milestone 32. Allowed stock/news data still leaves the host for Claude
in live mode; server credentials do not belong in prompts. Sensitive SDK transcripts remain private
artifacts, not logs. A malicious provider can poison factual content; deterministic authorization
prevents privilege expansion but cannot establish that the news is true.

## Verification and references

`tests/fixtures/adversarial-news.json` includes injected instructions, a foreign portfolio ID,
credential-exfiltration shell request, metadata URLs and malicious links. Tests deliberately issue
those calls directly and verify denial independently of any model refusal. PostgreSQL acceptance
also verifies direct foreign quote reads and ownership removal between discovery and retrieval.
The UI render tests supply malicious URLs even as cited evidence; provider tests prove only one
allowlisted request and no article fetch, and stop chunked oversized responses.

Verified 2026-10-03 against installed SDK 0.3.276 `sdk.d.ts`, Next.js 16.3.8 bundled route-handler
documentation and these official sources:

- [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions): allow rules can bypass permission callbacks; pre-tool hooks and handler authorization are necessary.
- [Secure SDK deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment): permission gates and directories do not provide OS isolation.
- [Kubernetes Restricted pod security](https://kubernetes.io/docs/concepts/security/pod-security-standards/): non-root, capability and seccomp requirements for the proposed design.
- [Node fetch](https://nodejs.org/api/globals.html#fetch): standard Request/Response streaming transport.
