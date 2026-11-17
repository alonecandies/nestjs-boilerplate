-- The sharding smoke fixture (B3 Task 18): one reference table and one tenant-distributed table,
-- both under forced RLS, with policies that call app.user_id() so that a context which does not
-- reach a node fails loudly there. Runs after the platform set (it calls its helpers).
CREATE SCHEMA IF NOT EXISTS "shipping";--> statement-breakpoint
CREATE TABLE "shipping"."carriers" (
	"code" text PRIMARY KEY NOT NULL
);--> statement-breakpoint
SELECT app.make_reference('shipping.carriers');--> statement-breakpoint
CREATE TABLE "shipping"."shipments" (
	"tenant_id" uuid NOT NULL,
	"id" integer NOT NULL,
	CONSTRAINT "shipments_pkey" PRIMARY KEY ("tenant_id", "id")
);--> statement-breakpoint
SELECT app.distribute_by_tenant('shipping.shipments');--> statement-breakpoint
ALTER TABLE "shipping"."carriers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipping"."carriers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipping"."shipments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipping"."shipments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Shapes Citus can propagate (probed on 14.2): no CASE, and no NULL test on a function call (both
-- fail with "unrecognized node type" when Citus deparses the policy). app.user_id() raises when the
-- context is missing and returns a uuid otherwise, so comparing it with the nil uuid is the
-- cheapest expression that calls it: never true for a real user. In the select policy it is the
-- LAST alternative of an OR (evaluated in order, only for rows the first two refuse), so a shard
-- that never received the context raises there instead of quietly returning nothing.
CREATE POLICY "carriers_select" ON "shipping"."carriers" FOR SELECT TO app_runtime
  USING (app.user_id() <> '00000000-0000-0000-0000-000000000000'::uuid);--> statement-breakpoint
CREATE POLICY "carriers_insert" ON "shipping"."carriers" FOR INSERT TO app_runtime
  WITH CHECK (app.user_id() <> '00000000-0000-0000-0000-000000000000'::uuid);--> statement-breakpoint
CREATE POLICY "shipments_select" ON "shipping"."shipments" FOR SELECT TO app_runtime
  USING (tenant_id = app.tenant_id() OR app.elevated()
    OR app.user_id() = '00000000-0000-0000-0000-000000000000'::uuid);--> statement-breakpoint
CREATE POLICY "shipments_insert" ON "shipping"."shipments" FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.tenant_id()
    AND app.user_id() <> '00000000-0000-0000-0000-000000000000'::uuid);--> statement-breakpoint
GRANT USAGE ON SCHEMA "shipping" TO app_runtime;--> statement-breakpoint
GRANT USAGE ON SCHEMA "shipping" TO app_system;--> statement-breakpoint
GRANT SELECT, INSERT ON "shipping"."carriers" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON "shipping"."shipments" TO app_runtime;--> statement-breakpoint
GRANT SELECT ON "shipping"."shipments" TO app_system;
