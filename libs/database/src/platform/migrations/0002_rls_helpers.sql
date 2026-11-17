-- @platform/database platform set, 0002: the RLS context helpers every policy calls, and the
-- platform half of the grant model (program spec 8.1, sharding design 7.1). The runtime context is
-- three transaction-local settings, sent on BEGIN as SET LOCAL (never set_config: Citus propagates
-- only SET LOCAL to the shard connections). Policies call these helpers directly, never through a
-- subquery (Citus rejects subqueries in policies). Deny by default: no function is executable by
-- PUBLIC; app_runtime and app_system get USAGE on schema app and EXECUTE on the four helpers they
-- need, and nothing on app.__drizzle_migrations. Creates no schema and distributes nothing.
-- Roles never come from a migration: they come from docker/postgres/init/02-roles.sql (docs/SECURITY.md,
-- "Database roles"), so a database without them stops here with a message saying so.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing
    FROM unnest(ARRAY['app_owner', 'app_runtime', 'app_system']) AS r(name)
    WHERE to_regrole(r.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'database role(s) missing: %', missing
      USING ERRCODE = '42704',
        HINT = 'Roles never come from a migration: run docker/postgres/init/02-roles.sql as a '
          || 'superuser first (docs/SECURITY.md, "Database roles").';
  END IF;
END
$$;--> statement-breakpoint
-- Functions app_owner creates from now on are not executable by PUBLIC: each one is granted to the
-- role that needs it, in the migration that creates it. Global (not IN SCHEMA): a per-schema default
-- privilege cannot take away what PUBLIC gets.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;--> statement-breakpoint
-- The acting user. Raises (42501) when unset or empty: every runtime unit of work has a user, so a
-- missing context fails loudly instead of returning empty results.
CREATE OR REPLACE FUNCTION app.user_id() RETURNS uuid
  LANGUAGE plpgsql STABLE
  AS $$
DECLARE
  raw text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF raw IS NULL THEN
    RAISE EXCEPTION 'app.user_id is not set' USING ERRCODE = '42501';
  END IF;
  RETURN raw::uuid;
END;
$$;--> statement-breakpoint
-- The active tenant, or NULL when unset or empty (a tenant-less unit of work sees no tenant rows).
CREATE OR REPLACE FUNCTION app.tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;--> statement-breakpoint
-- True only for the literal 'on' (what elevate() sends); unset, 'off' and anything else are false.
CREATE OR REPLACE FUNCTION app.elevated() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.elevated', true) = 'on', false) $$;--> statement-breakpoint
-- Deny by default, whoever runs this file: explicit, since the default privilege above covers only
-- functions app_owner creates, and 0001 may have run as another role.
REVOKE EXECUTE ON FUNCTION app.user_id() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.tenant_id() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.elevated() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.citus_enabled() FROM PUBLIC;--> statement-breakpoint
-- The 0001 distribution helpers are for migrations (app_owner) only.
REVOKE EXECUTE ON FUNCTION app.citus_table_kind(regclass) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.distribute_by_tenant(regclass) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.distribute_by_user(regclass) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.make_reference(regclass) FROM PUBLIC;--> statement-breakpoint
-- USAGE only: neither app role creates in schema app or reads its bookkeeping table.
GRANT USAGE ON SCHEMA app TO app_runtime;--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO app_system;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.user_id() TO app_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.user_id() TO app_system;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tenant_id() TO app_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tenant_id() TO app_system;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.elevated() TO app_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.elevated() TO app_system;--> statement-breakpoint
-- The boot guard (and anything Citus-aware) asks app.citus_enabled() on the runtime connection.
GRANT EXECUTE ON FUNCTION app.citus_enabled() TO app_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.citus_enabled() TO app_system;
