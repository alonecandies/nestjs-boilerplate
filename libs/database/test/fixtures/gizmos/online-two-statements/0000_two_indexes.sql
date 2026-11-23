-- Two statements in one file: refused, an online file holds exactly one.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "gizmos_name_idx" ON "gizmos"."gizmos" ("name");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "gizmos_code_idx" ON "gizmos"."gizmos" ("code");
