-- The boot guard fixture (B3 Task 8): one tenant table, distributed and under forced RLS, as every
-- domain table must be. No policy: the guard reads the catalog, never the rows.
CREATE SCHEMA IF NOT EXISTS "guarded";--> statement-breakpoint
CREATE TABLE "guarded"."records" (
	"tenant_id" uuid NOT NULL,
	"id" integer NOT NULL,
	CONSTRAINT "records_pkey" PRIMARY KEY ("tenant_id", "id")
);--> statement-breakpoint
SELECT app.distribute_by_tenant('guarded.records');--> statement-breakpoint
ALTER TABLE "guarded"."records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "guarded"."records" FORCE ROW LEVEL SECURITY;
