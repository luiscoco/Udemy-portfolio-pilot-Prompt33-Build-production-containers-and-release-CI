-- Milestone 32: W3C trace context carried across durable hops (diagnostic, nullable, expand-only).
ALTER TABLE "AgentRun" ADD COLUMN "traceparent" VARCHAR(55);
ALTER TABLE "OutboxEvent" ADD COLUMN "traceparent" VARCHAR(55);
