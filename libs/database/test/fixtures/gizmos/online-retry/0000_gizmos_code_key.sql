-- Fails while two rows of a tenant share a code, leaving an invalid index behind.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "gizmos_code_key" ON "gizmos"."gizmos" ("tenant_id", "code");
