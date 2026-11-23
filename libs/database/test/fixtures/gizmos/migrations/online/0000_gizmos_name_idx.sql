-- Re-runnable (IF NOT EXISTS); built without blocking writes to gizmos.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "gizmos_name_idx" ON "gizmos"."gizmos" ("name");
