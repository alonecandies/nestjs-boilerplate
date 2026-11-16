-- @platform/database platform set, 0001: Citus distribution helpers (Citus-optional).
-- Without the citus extension in this database every helper returns at once, so plain Postgres
-- runs the same history. Each one reads pg_dist_partition first (create_distributed_table is not
-- idempotent), so a re-run or a squashed 0000_init is safe, and a call that would change a table's
-- kind raises instead. Bodies that name Citus objects are plpgsql, which resolves names only when a
-- line runs. Domain sets call them from a hand-written `distribute` migration (docs/DEVELOPMENT.md,
-- "Citus-ready schema rules"): reference tables first, then tenant tables, then user tables.
CREATE OR REPLACE FUNCTION app.citus_enabled() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'citus') $$;--> statement-breakpoint
-- The colocation anchor of every tenant-distributed table: always empty, never queried.
-- app.distribute_by_tenant distributes it first (with the server's citus.shard_count at that
-- moment), and colocates every tenant table with it, so they all share one shard map.
CREATE TABLE IF NOT EXISTS app.tenant_colocation (tenant_id uuid PRIMARY KEY);--> statement-breakpoint
-- 'reference', 'hash:<distribution column>', 'local' (not a Citus table), 'other' (a Citus local or
-- single-shard table), or NULL without the citus extension.
CREATE OR REPLACE FUNCTION app.citus_table_kind(t regclass) RETURNS text
  LANGUAGE plpgsql STABLE
  AS $$
DECLARE
  p record;
BEGIN
  IF NOT app.citus_enabled() THEN
    RETURN NULL;
  END IF;
  SELECT d.partmethod, d.repmodel, d.partkey INTO p
    FROM pg_dist_partition d WHERE d.logicalrelid = t;
  IF NOT FOUND THEN
    RETURN 'local';
  ELSIF p.partmethod = 'h' THEN
    RETURN 'hash:' || column_to_column_name(t, p.partkey);
  ELSIF p.repmodel = 't' THEN
    RETURN 'reference';
  END IF;
  RETURN 'other';
END;
$$;--> statement-breakpoint
-- Hash-distributes t on tenant_id, colocated with app.tenant_colocation.
CREATE OR REPLACE FUNCTION app.distribute_by_tenant(t regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  kind text;
BEGIN
  IF NOT app.citus_enabled() THEN
    RETURN;
  END IF;
  IF app.citus_table_kind('app.tenant_colocation') IS DISTINCT FROM 'hash:tenant_id' THEN
    PERFORM create_distributed_table('app.tenant_colocation', 'tenant_id', colocate_with => 'none');
  END IF;
  IF t = 'app.tenant_colocation'::regclass THEN
    RETURN;
  END IF;
  kind := app.citus_table_kind(t);
  IF kind = 'hash:tenant_id'
     AND (SELECT colocationid FROM pg_dist_partition WHERE logicalrelid = t)
       = (SELECT colocationid FROM pg_dist_partition
          WHERE logicalrelid = 'app.tenant_colocation'::regclass) THEN
    RETURN;
  END IF;
  IF kind NOT IN ('local', 'other') THEN
    RAISE EXCEPTION 'app.distribute_by_tenant(%): already a Citus table of another kind (%), not colocated with app.tenant_colocation', t, kind;
  END IF;
  PERFORM create_distributed_table(t, 'tenant_id', colocate_with => 'app.tenant_colocation');
END;
$$;--> statement-breakpoint
-- Hash-distributes t on user_id, colocated with the first user-distributed table (the first one
-- opens its own group), so every user table shares one shard map, apart from the tenant tables.
CREATE OR REPLACE FUNCTION app.distribute_by_user(t regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  kind text;
  peer regclass;
BEGIN
  IF NOT app.citus_enabled() THEN
    RETURN;
  END IF;
  kind := app.citus_table_kind(t);
  IF kind = 'hash:user_id' THEN
    RETURN;
  END IF;
  IF kind NOT IN ('local', 'other') THEN
    RAISE EXCEPTION 'app.distribute_by_user(%): already a Citus table of another kind (%)', t, kind;
  END IF;
  SELECT d.logicalrelid INTO peer
    FROM pg_dist_partition d
    WHERE d.partmethod = 'h' AND column_to_column_name(d.logicalrelid, d.partkey) = 'user_id'
    ORDER BY d.colocationid, d.logicalrelid::oid
    LIMIT 1;
  PERFORM create_distributed_table(t, 'user_id',
    colocate_with => CASE WHEN peer IS NULL THEN 'none' ELSE peer::text END);
END;
$$;--> statement-breakpoint
-- Replicates t to every node (create_reference_table).
CREATE OR REPLACE FUNCTION app.make_reference(t regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  kind text;
BEGIN
  IF NOT app.citus_enabled() THEN
    RETURN;
  END IF;
  kind := app.citus_table_kind(t);
  IF kind = 'reference' THEN
    RETURN;
  END IF;
  IF kind NOT IN ('local', 'other') THEN
    RAISE EXCEPTION 'app.make_reference(%): already distributed (%)', t, kind;
  END IF;
  PERFORM create_reference_table(t);
END;
$$;
