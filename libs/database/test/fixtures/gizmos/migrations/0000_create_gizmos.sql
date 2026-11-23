-- The online-steps fixture (OPS-2): one tenant table, distributed on Citus (the platform helper is
-- a no-op on plain Postgres). Its indexes come from online/ here and the online-* folders.
CREATE SCHEMA IF NOT EXISTS "gizmos";--> statement-breakpoint
CREATE TABLE "gizmos"."gizmos" (
	"tenant_id" uuid NOT NULL,
	"id" integer NOT NULL,
	"name" text NOT NULL,
	"code" text,
	CONSTRAINT "gizmos_pkey" PRIMARY KEY ("tenant_id", "id")
);--> statement-breakpoint
SELECT app.distribute_by_tenant('gizmos.gizmos');
