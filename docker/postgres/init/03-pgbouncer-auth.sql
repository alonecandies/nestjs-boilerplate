-- PgBouncer's password lookup (sharding design section 5, "Auth"), as the superuser, after
-- 02-roles.sql. Production PgBouncer logs in as pgbouncer_auth (auth_user) and runs
--   auth_query = SELECT usename, passwd FROM pgbouncer.get_auth($1)
-- so no secret file holds the SCRAM verifiers. The function answers only for the two pooled roles:
-- never for app_owner (direct connections only), a superuser or any other name.
-- Same rules as 02-roles.sql: plain SQL, one transaction, safe to run twice.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pgbouncer_auth') THEN
    CREATE ROLE pgbouncer_auth;
  END IF;
END
$$;

ALTER ROLE pgbouncer_auth WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'pgbouncer_auth';
ALTER ROLE pgbouncer_auth SET search_path = pg_catalog;

CREATE SCHEMA IF NOT EXISTS pgbouncer;
REVOKE ALL ON SCHEMA pgbouncer FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;

-- SECURITY DEFINER (owned by the superuser that runs this file) with a pinned search_path.
CREATE OR REPLACE FUNCTION pgbouncer.get_auth(p_usename text)
  RETURNS TABLE (usename name, passwd text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
    SELECT s.usename, s.passwd
      FROM pg_catalog.pg_shadow s
     WHERE s.usename = p_usename
       AND s.usename IN ('app_runtime', 'app_system')
       AND NOT s.usesuper
       AND (s.valuntil IS NULL OR s.valuntil > pg_catalog.now())
  $$;

REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer_auth;
