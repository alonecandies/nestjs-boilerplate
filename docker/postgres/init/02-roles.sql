-- The three database roles (program spec section 4, sharding design section 7.3), as the superuser.
-- One script for every environment: compose runs it once on an empty data directory
-- (docker-entrypoint-initdb.d, after 01-extensions.sql); @platform/testing/postgres sends it as
-- initSql (readRolesInitSql) in every spec that asserts isolation. So: plain SQL, no psql
-- meta-commands, nothing that cannot run inside one transaction, and safe to run twice (each
-- ALTER below converges an existing role to the same state).
-- Dev passwords equal the role names. docs/SECURITY.md ("Database roles") gives the production form.
--
--   app_owner    owns schemas and tables; migrations, drizzle-kit, operator CLIs (direct coordinator)
--   app_runtime  NOSUPERUSER NOBYPASSRLS: every request (through PgBouncer)
--   app_system   BYPASSRLS: the named system methods only (through PgBouncer, small pool)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system;
  END IF;
END
$$;

ALTER ROLE app_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'app_owner';
ALTER ROLE app_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'app_runtime';
ALTER ROLE app_system WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS
  PASSWORD 'app_system';

-- Only the owner creates schemas. PUBLIC keeps CONNECT (and TEMPORARY), never CREATE.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO app_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_runtime, app_system', current_database());
END
$$;

-- An explicit search_path per role, so nothing resolves through a schema that happens to share a
-- role's name ("$user"). Every application object is schema-qualified.
ALTER ROLE app_owner SET search_path = pg_catalog, public;
ALTER ROLE app_runtime SET search_path = pg_catalog, public;
ALTER ROLE app_system SET search_path = pg_catalog, public;

-- Server settings of the two pooled roles (sharding design section 7.3). They live here, not in
-- migrations or the client: PgBouncer rejects both timeouts as startup parameters. Citus prepends
-- SET LOCAL commands to every remote BEGIN only with propagate_set_commands = 'local'; without it,
-- the RLS context never reaches a shard. app_owner gets none of them (the migrator sets its own).
ALTER ROLE app_runtime SET citus.propagate_set_commands = 'local';
ALTER ROLE app_runtime SET statement_timeout = '15s';
ALTER ROLE app_runtime SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE app_system SET citus.propagate_set_commands = 'local';
ALTER ROLE app_system SET statement_timeout = '15s';
ALTER ROLE app_system SET idle_in_transaction_session_timeout = '60s';

-- app_owner's lock_timeout (OPS-2): the migrator sends DATABASE_MIGRATION_LOCK_TIMEOUT_MS (5000 by
-- default) as a startup parameter, but on Citus that reaches the coordinator only; the connections
-- it opens to the workers start from this role default. The migrator keeps it equal to its setting
-- (ALTER ROLE CURRENT_USER, only when it differs); this is the same default, set up front.
ALTER ROLE app_owner SET lock_timeout = '5s';

-- pg_trgm as the superuser (01-extensions.sql does it in compose, but Testcontainers never runs that
-- file): the platform set's CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public is then a no-op
-- for app_owner, which has no CREATE on schema public.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
