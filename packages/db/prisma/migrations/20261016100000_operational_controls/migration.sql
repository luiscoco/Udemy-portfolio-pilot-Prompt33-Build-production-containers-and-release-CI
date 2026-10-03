-- Milestone 30: scoped operator credentials and an append-only administrative audit log.
CREATE TABLE "OperatorCredential" (
    "id" TEXT NOT NULL,
    "operator" VARCHAR(64) NOT NULL,
    "tokenSha256" CHAR(64) NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OperatorCredential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperatorCredential_token_check" CHECK ("tokenSha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "OperatorCredential_operator_check" CHECK ("operator" ~ '^[A-Za-z0-9_.@-]{1,64}$'),
    CONSTRAINT "OperatorCredential_scopes_check" CHECK (cardinality("scopes") > 0 AND "scopes" <@ ARRAY['ops:read','runs:recover','outbox:requeue']::TEXT[]),
    CONSTRAINT "OperatorCredential_expiry_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '24 hours')
);

CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT,
    "operator" VARCHAR(64),
    "action" VARCHAR(64) NOT NULL,
    "targetType" VARCHAR(32),
    "targetId" VARCHAR(128),
    "reason" VARCHAR(500),
    "outcome" VARCHAR(16) NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdminAuditLog_outcome_check" CHECK ("outcome" IN ('requested','succeeded','noop','denied','failed'))
);

CREATE UNIQUE INDEX "OperatorCredential_tokenSha256_key" ON "OperatorCredential"("tokenSha256");
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");
CREATE INDEX "AdminAuditLog_credentialId_createdAt_idx" ON "AdminAuditLog"("credentialId", "createdAt");

-- Audit rows can be inserted but never edited or deleted by the application role.
CREATE FUNCTION "AdminAuditLog_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AdminAuditLog is append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER "AdminAuditLog_no_update_delete" BEFORE UPDATE OR DELETE ON "AdminAuditLog"
  FOR EACH ROW EXECUTE FUNCTION "AdminAuditLog_append_only"();
-- Queue-depth monitoring reads queued/active work by status and age.
CREATE INDEX "AgentRun_active_lease" ON "AgentRun"("leaseUntil") WHERE "status" IN ('running','waiting_for_approval');
