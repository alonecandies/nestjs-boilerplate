-- Custom (drizzle-kit generate --custom --name rls): B3-5, B3-6, program spec 8.2 (billing rows),
-- sharding design 7.1. Forced RLS on both billing tables, the policies, then explicit grants.
-- Deny by default: no table default privileges; a table added later is unreachable until its own
-- migration grants it. billing.__drizzle_migrations gets no RLS and no grant to either app role.
-- Policies call the platform helpers (0002_rls_helpers) directly, never through a subquery (Citus
-- rejects subqueries in policies), and billing has no helper or FK into identity.
-- Rows with tenant_id = PLATFORM_TENANT_ID match no runtime policy (no runtime principal carries the
-- nil UUID): only app_system (BYPASSRLS) reads or writes them. app_system gets SELECT, INSERT and
-- DELETE on stripe_events only (the Stripe events system methods) and nothing on payments.
-- FORCE also filters the owner: app_owner has no policy, so it reads and writes no row.
ALTER TABLE billing.payments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing.payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing.stripe_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing.stripe_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- A member reads its own payments in the active tenant; elevation (billing:read-all) reads the
-- tenant's. Writes stay the member's own: elevation reads, it never writes another member's payment.
CREATE POLICY payments_select ON billing.payments FOR SELECT TO app_runtime
  USING (tenant_id = app.tenant_id() AND (user_id = app.user_id() OR app.elevated()));--> statement-breakpoint
CREATE POLICY payments_insert ON billing.payments FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());--> statement-breakpoint
CREATE POLICY payments_update ON billing.payments FOR UPDATE TO app_runtime
  USING (tenant_id = app.tenant_id() AND user_id = app.user_id())
  WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());--> statement-breakpoint
-- The webhook records an event as the owner in the signed metadata; user-less (platform) events go
-- through the system pool. No UPDATE or DELETE for the runtime role (no grant either).
CREATE POLICY stripe_events_select ON billing.stripe_events FOR SELECT TO app_runtime
  USING (tenant_id = app.tenant_id() AND user_id = app.user_id());--> statement-breakpoint
CREATE POLICY stripe_events_insert ON billing.stripe_events FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());--> statement-breakpoint
-- USAGE only: neither app role creates in schema billing.
GRANT USAGE ON SCHEMA billing TO app_runtime;--> statement-breakpoint
GRANT USAGE ON SCHEMA billing TO app_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE billing.payments TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE billing.stripe_events TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE billing.stripe_events TO app_system;
