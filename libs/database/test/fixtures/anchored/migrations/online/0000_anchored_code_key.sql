-- Anchored at 0000: runs after transactional 0000 and before 0001, which turns it into a constraint.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "anchored_code_key" ON "anchored"."anchored" ("code");
