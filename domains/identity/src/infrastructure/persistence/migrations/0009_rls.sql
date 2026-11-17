-- Identity set, 0009: row-level security on every identity table (program spec 8.2, row-local per the
-- ruling of 2026-11-17; B3 plan Task 10). Deny by default: RLS is enabled AND forced on all six
-- tables (the owner is filtered too), and each role gets explicit per-table grants (no default
-- privileges), so a table or a column nobody granted stays unreachable. Every policy uses only the
-- row's own columns and app.user_id(), app.tenant_id(), app.elevated() (which read current_setting),
-- called directly: no subquery (Citus rejects them) and no function that reads a table (on Citus a
-- nested read from a shard query fails). Co-member and cross-tenant reads are app-asserted reads on
-- the system pool, with the tenant filter in their SQL. identity.__drizzle_migrations gets no RLS
-- and no grant to either app role.
-- Roles: app_runtime (NOBYPASSRLS) is every request; app_system (BYPASSRLS) is the named system
-- methods only; app_owner (owner, migrations, the staff:grant CLI) passes FORCE RLS on users alone.
GRANT USAGE ON SCHEMA identity TO app_runtime;--> statement-breakpoint
GRANT USAGE ON SCHEMA identity TO app_system;--> statement-breakpoint
ALTER TABLE identity.users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.users FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.tenants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.memberships FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.audit_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE identity.audit_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- users: only staff:grant (as app_owner) sets is_platform_staff. INSERT is table-level because Citus
-- lists every defaulted column in the shard INSERT (a column list fails even for register); the
-- users_insert check refuses the flag instead. The UPDATE column list leaves it out.
GRANT SELECT, INSERT ON TABLE identity.users TO app_runtime;--> statement-breakpoint
GRANT UPDATE (email, password_hash, display_name, updated_at) ON TABLE identity.users TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE identity.tenants TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity.memberships TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity.invitations TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE identity.sessions TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE identity.audit_events TO app_runtime;--> statement-breakpoint
-- app_system (spec section 9 methods 1-5): credentials and email lookups, the token lookup, the purge;
-- and the app-asserted reads the row-local policies leave out (the member directory, users JOIN
-- memberships on the asserted tenant; the caller's tenants outside the session tenant).
GRANT SELECT ON TABLE identity.users TO app_system;--> statement-breakpoint
GRANT SELECT ON TABLE identity.tenants TO app_system;--> statement-breakpoint
GRANT SELECT ON TABLE identity.memberships TO app_system;--> statement-breakpoint
GRANT SELECT ON TABLE identity.invitations TO app_system;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE identity.sessions TO app_system;--> statement-breakpoint
-- users
CREATE POLICY users_select ON identity.users FOR SELECT TO app_runtime
  USING (id = app.user_id());--> statement-breakpoint
CREATE POLICY users_insert ON identity.users FOR INSERT TO app_runtime
  WITH CHECK (id = app.user_id() AND NOT is_platform_staff);--> statement-breakpoint
CREATE POLICY users_update ON identity.users FOR UPDATE TO app_runtime
  USING (id = app.user_id())
  WITH CHECK (id = app.user_id());--> statement-breakpoint
-- staff:grant (system method 7) connects as app_owner, which FORCE RLS filters like everyone else.
CREATE POLICY users_owner_select ON identity.users FOR SELECT TO app_owner
  USING (true);--> statement-breakpoint
CREATE POLICY users_owner_update ON identity.users FOR UPDATE TO app_owner
  USING (true);--> statement-breakpoint
-- tenants
CREATE POLICY tenants_select ON identity.tenants FOR SELECT TO app_runtime
  USING (id = app.tenant_id());--> statement-breakpoint
CREATE POLICY tenants_insert ON identity.tenants FOR INSERT TO app_runtime
  WITH CHECK (id = app.tenant_id());--> statement-breakpoint
CREATE POLICY tenants_update ON identity.tenants FOR UPDATE TO app_runtime
  USING (id = app.tenant_id() AND app.elevated())
  WITH CHECK (id = app.tenant_id() AND app.elevated());--> statement-breakpoint
-- memberships: leaving deletes my own row, but nobody edits their own roles
CREATE POLICY memberships_select ON identity.memberships FOR SELECT TO app_runtime
  USING (user_id = app.user_id() OR tenant_id = app.tenant_id());--> statement-breakpoint
CREATE POLICY memberships_insert ON identity.memberships FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.tenant_id() AND app.elevated());--> statement-breakpoint
CREATE POLICY memberships_update ON identity.memberships FOR UPDATE TO app_runtime
  USING (tenant_id = app.tenant_id() AND app.elevated())
  WITH CHECK (tenant_id = app.tenant_id() AND app.elevated());--> statement-breakpoint
CREATE POLICY memberships_delete ON identity.memberships FOR DELETE TO app_runtime
  USING (tenant_id = app.tenant_id() AND (app.elevated() OR user_id = app.user_id()));--> statement-breakpoint
-- invitations
CREATE POLICY invitations_select ON identity.invitations FOR SELECT TO app_runtime
  USING (tenant_id = app.tenant_id() AND app.elevated());--> statement-breakpoint
CREATE POLICY invitations_insert ON identity.invitations FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.tenant_id() AND app.elevated());--> statement-breakpoint
CREATE POLICY invitations_update ON identity.invitations FOR UPDATE TO app_runtime
  USING (tenant_id = app.tenant_id() AND app.elevated())
  WITH CHECK (tenant_id = app.tenant_id() AND app.elevated());--> statement-breakpoint
CREATE POLICY invitations_delete ON identity.invitations FOR DELETE TO app_runtime
  USING (tenant_id = app.tenant_id() AND app.elevated());--> statement-breakpoint
-- sessions (the purge DELETE is app_system's)
CREATE POLICY sessions_select ON identity.sessions FOR SELECT TO app_runtime
  USING (user_id = app.user_id());--> statement-breakpoint
CREATE POLICY sessions_insert ON identity.sessions FOR INSERT TO app_runtime
  WITH CHECK (user_id = app.user_id() AND tenant_id = app.tenant_id());--> statement-breakpoint
CREATE POLICY sessions_update ON identity.sessions FOR UPDATE TO app_runtime
  USING (user_id = app.user_id())
  WITH CHECK (user_id = app.user_id());--> statement-breakpoint
-- audit_events: append-only (no UPDATE or DELETE grant)
CREATE POLICY audit_events_select ON identity.audit_events FOR SELECT TO app_runtime
  USING (tenant_id = app.tenant_id() AND app.elevated());--> statement-breakpoint
CREATE POLICY audit_events_insert ON identity.audit_events FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app.tenant_id());
