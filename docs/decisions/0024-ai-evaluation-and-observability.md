# 0024. AI evaluation and observability

- Status: Accepted
- Date: 2026-10-03
- Milestone: 32

## Context

The agent's answers drive research recommendations about real holdings, and its inputs include
untrusted news. Earlier milestones had unit tests for validators and a mock agent, but no measure of
answer *quality* across known traps, and no way to follow one piece of work through the system:
an article crosses the ingestion worker, PostgreSQL, the outbox dispatcher, Redis Streams, an API
replica and the browser; a question crosses an API replica, a PostgreSQL job, an agent worker, its
tools, the outbox and SSE. Logs were partly free text, and no metrics existed.

## Decision

### Evaluation

1. **Versioned dataset** `packages/agent/eval/datasets/portfolio-news-v1.json` (semantic version in
   the file). Each case is a self-contained, owner-bound world (holdings, quotes, articles, foreign
   IDs) plus expectations: required and forbidden evidence, stale evidence, affected holdings,
   required uncertainty topics, required and forbidden tools, injection canaries, acceptable typed
   refusals, and a human-readable permissible interpretation. Traps: missing quote, stale news,
   contradictory sources, irrelevant articles, prompt injection, foreign data.
2. **Same production pieces.** The runner uses the real prompt builder, tool server, evidence
   registry, `validateNewsAnalysis`, bounded correction retry and Markdown rendering. Only
   persistence, SSE and approvals are replaced (the approval port records and denies).
3. **Deterministic checks are separate from model-judged rubrics.** Deterministic checks are split
   into *gates* (schema and citation validity, supported claims (figures and tickers traceable to
   cited sources or tool results), interpretation bounds, tool policy, injection resistance, privacy,
   latency, cost), which fail the command, and *scores* (evidence recall, relevance, affected
   holdings, uncertainty handling, tool selection, first-attempt validity), which are compared
   across runs. No check uses text similarity to a reference answer. The model-judged rubric is
   optional, live-only and advisory; it never gates.
4. **Two commands.** `npm run eval:mock` needs no credentials. `npm run eval:live` refuses to start
   without `--budget-usd` (ceiling 20 USD), sets each run's SDK cost cap to min(per-case cap,
   remaining budget), charges unreported usage at the cap, and skips cases once less than
   0.01 USD remains.

### Observability

5. **OpenTelemetry JS SDK 2.x, OTLP/HTTP only** (`@opentelemetry/sdk-trace-node`,
   `sdk-metrics`, `exporter-trace-otlp-http`, `exporter-metrics-otlp-http`, `exporter-prometheus`;
   versions in `docs/versions.md`). The application does not link an Azure SDK. Azure Monitor
   receives data through an OpenTelemetry Collector using Azure Monitor's native OTLP ingestion
   with the `azure_auth` extension (Microsoft Learn, "Ingest OTLP data into Azure Monitor with OTel
   Collector", updated 2026-05-31; requires collector ≥ 0.148.0). The direct
   `@azure/monitor-opentelemetry-exporter` was rejected: its npm `latest` tag is a 1.0.0 beta.
6. **Trace context crosses durable hops as data.** A nullable `traceparent` column on `AgentRun`
   and `OutboxEvent` (expand-only migration `20261017100000_trace_context`) and a `traceparent`
   field beside the envelope in each Redis Stream entry. Consumers start their span as a child of
   the stored context. Each ingested article starts its own trace (linked to the ingestion pass).
   The event contract and browser DTOs are unchanged.
7. **Correlation identifiers.** request ID (`X-Request-ID`, now one per request and returned on
   every JSON response), `pp.actor` (keyed HMAC pseudonym `act_<16 hex>`, key from
   `OBSERVABILITY_ACTOR_KEY` or derived from `AUTH_SECRET`), job and run IDs (the durable job row is
   the run row), tool-call ID (`<messageId>.tN`), outbox event ID, and SSE event ID (the
   browser-visible DTO ID). These appear in spans and logs, never in metric labels.
8. **Three layers of data minimization.**
   - Helpers accept only allowlisted attribute keys with bounded scalar values.
   - A sanitizing exporter wrapper re-applies an allowlist to *every* span, including those Next.js
     and Better Auth create. It drops URLs with query strings, SQL, span events (exception messages)
     and status messages.
   - Metric labels have a fixed key allowlist and enum-like values. `tool` has an exact value list,
     because mixed case would admit tickers.
9. **Structured JSON-lines logs** with UTC time, level, stable event name, service, active trace and
   span IDs and redacted fields; errors are reduced to a class name.
10. **Local inspection.** `OTEL_TRACES_EXPORTER=file` (rejected in production) plus
    `npm run trace:inspect`, an optional Jaeger 2.21.0 Compose profile for OTLP, and a loopback
    Prometheus scrape endpoint.

## Consequences

- One article and one question are verified end to end in Chrome against two API replicas
  (`observability.spec.ts`), with exact parent/child relations across processes.
- Next.js records its own route spans once a provider is registered; health probes create many
  small traces. Sampling (`OTEL_TRACES_SAMPLER_ARG`) or a collector filter should drop probe traces
  in production (milestone 35).
- Article text, prompts and answers never reach telemetry, so a trace shows *where* time and failures
  occurred, not *what* was said. Content review uses the evaluation reports, which contain only
  synthetic data.
- The lexical deterministic checks can miss a fabricated claim with no figure or ticker, and can
  misjudge a paraphrased uncertainty; the judge rubric covers meaning but is non-deterministic and
  biased. Both limits are documented in lesson 32.
- `traceparent` is a diagnostic column; a future contract migration may drop it without data loss.
