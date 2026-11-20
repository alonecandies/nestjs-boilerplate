import type { Sql } from 'postgres';

/** One catalog row: column name to value, as postgres.js returns it. */
type CatalogRow = Record<string, unknown>;

/**
 * The schema-level state of some Postgres schemas, every part in a fixed order, so two databases
 * built by different migration histories compare with one `toEqual` (the final squash, SH-12).
 * Values that only name an object's place in one database are left out or normalised: columns are
 * keyed by name, not by `attnum` (a column added by `ALTER TABLE` sits last, the squashed `CREATE
 * TABLE` lists it where the schema declares it); a Citus distribution column by name, not by the
 * stored `partkey` (which holds the `attnum`); a colocation group by its member tables, not by
 * `colocationid`; a NOT NULL constraint by its column, not by its generated name (Citus' conversion
 * of a local table that has foreign keys recreates it under a temporary name, so its NOT NULL
 * constraints keep names like `sessions_4135702642_id_not_null`). Citus shards are hidden from
 * `pg_class` (`citus.override_table_visibility`).
 */
export interface SchemaCatalog {
  /** Schemas: owner and the exploded `USAGE`/`CREATE` grants. */
  schemas: CatalogRow[];
  /** Tables, views, sequences: kind, persistence, owner, RLS enabled and forced. */
  relations: CatalogRow[];
  /** Live columns by table and name: type, NOT NULL, default, `attidentity`, generated, collation. */
  columns: CatalogRow[];
  /**
   * Constraints by table, kind and `pg_get_constraintdef`, with their names; a NOT NULL constraint
   * (Postgres 18 stores them in `pg_constraint`) without its generated name.
   */
  constraints: CatalogRow[];
  /** Indexes by table and name: `pg_get_indexdef`. */
  indexes: CatalogRow[];
  /** Row-level security policies: command, roles, permissive, `USING` and `WITH CHECK`. */
  policies: CatalogRow[];
  /** Table-level grants, one row per grantee and privilege (`PUBLIC` when the grantee is 0). */
  tableGrants: CatalogRow[];
  /** Column-level grants, one row per column, grantee and privilege. */
  columnGrants: CatalogRow[];
  /** Enum types with their labels in sort order, and their owner. */
  enums: CatalogRow[];
  /** Functions and procedures: `pg_get_functiondef` and the exploded grants. */
  functions: CatalogRow[];
  /** User triggers (not the internal FK ones): `pg_get_triggerdef`. */
  triggers: CatalogRow[];
  /**
   * Citus metadata (`pg_dist_partition`): method, distribution column, replication model, shard
   * count, the hash ranges of the shards, and the colocation group as its sorted member tables.
   * Empty without the `citus` extension.
   */
  distribution: CatalogRow[];
}

/** Reads the catalog of `schemas` through `sql`, which must be allowed to read the catalogs. */
export async function readSchemaCatalog(
  sql: Sql,
  schemas: readonly string[],
): Promise<SchemaCatalog> {
  const names = [...schemas];
  const rows = async (query: Promise<CatalogRow[]>): Promise<CatalogRow[]> =>
    (await query).map((row) => ({ ...row }));
  const [citus] = await sql<{ installed: boolean }[]>`
    select exists (select 1 from pg_extension where extname = 'citus') as installed`;
  return {
    schemas: await rows(sql`
      select n.nspname as schema, pg_get_userbyid(n.nspowner) as owner,
        coalesce((select array_agg(g.entry order by g.entry) from (
            select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
              || ':' || a.privilege_type || ':' || a.is_grantable as entry
            from aclexplode(n.nspacl) a) g), '{}') as grants
      from pg_namespace n
      where n.nspname = any(${names}::text[])
      order by n.nspname`),
    relations: await rows(sql`
      select n.nspname || '.' || c.relname as relation, c.relkind::text as kind,
        c.relpersistence::text as persistence, pg_get_userbyid(c.relowner) as owner,
        c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${names}::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      order by 1`),
    columns: await rows(sql`
      select n.nspname || '.' || c.relname as relation, a.attname as column,
        format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
        pg_get_expr(d.adbin, d.adrelid) as default, a.attidentity::text as attidentity,
        a.attgenerated::text as generated, co.collname as collation
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      left join pg_collation co on co.oid = a.attcollation and a.attcollation <> 0
      where n.nspname = any(${names}::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and a.attnum > 0 and not a.attisdropped
      order by 1, 2`),
    constraints: await rows(sql`
      select n.nspname || '.' || c.relname as relation,
        case when k.contype = 'n' then null else k.conname end as name,
        k.contype::text as kind, pg_get_constraintdef(k.oid) as definition
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${names}::text[])
      order by 1, 3, 4, k.conname`),
    indexes: await rows(sql`
      select schemaname || '.' || tablename as relation, indexname as name, indexdef as definition
      from pg_indexes
      where schemaname = any(${names}::text[])
      order by 1, 2`),
    policies: await rows(sql`
      select schemaname || '.' || tablename as relation, policyname as name, permissive,
        roles::text[] as roles, cmd as command, qual as using, with_check as check
      from pg_policies
      where schemaname = any(${names}::text[])
      order by 1, 2`),
    tableGrants: await rows(sql`
      select n.nspname || '.' || c.relname as relation,
        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
        a.privilege_type as privilege, a.is_grantable as grantable,
        pg_get_userbyid(a.grantor) as grantor
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      where n.nspname = any(${names}::text[])
      order by 1, 2, 3`),
    columnGrants: await rows(sql`
      select n.nspname || '.' || c.relname as relation, at.attname as column,
        case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
        a.privilege_type as privilege, a.is_grantable as grantable
      from pg_attribute at
      join pg_class c on c.oid = at.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(at.attacl) a
      where n.nspname = any(${names}::text[]) and at.attnum > 0 and not at.attisdropped
      order by 1, 2, 3, 4`),
    enums: await rows(sql`
      select n.nspname || '.' || t.typname as type, pg_get_userbyid(t.typowner) as owner,
        (select array_agg(e.enumlabel order by e.enumsortorder) from pg_enum e
          where e.enumtypid = t.oid) as labels
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = any(${names}::text[]) and t.typtype = 'e'
      order by 1`),
    functions: await rows(sql`
      select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as function,
        pg_get_userbyid(p.proowner) as owner, pg_get_functiondef(p.oid) as definition,
        coalesce((select array_agg(g.entry order by g.entry) from (
            select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
              || ':' || a.privilege_type as entry
            from aclexplode(p.proacl) a) g), '{}') as grants
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any(${names}::text[]) and p.prokind in ('f', 'p')
      order by 1`),
    triggers: await rows(sql`
      select n.nspname || '.' || c.relname as relation, t.tgname as name,
        pg_get_triggerdef(t.oid) as definition
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${names}::text[]) and not t.tgisinternal
      order by 1, 2`),
    distribution:
      citus?.installed === true
        ? await rows(sql`
            select n.nspname || '.' || c.relname as relation, p.partmethod::text as method,
              case when p.partkey is null then null
                else column_to_column_name(p.logicalrelid, p.partkey) end as column,
              p.repmodel::text as replication,
              case when p.colocationid = 0 then null else (
                select array_agg(on_.nspname || '.' || oc.relname
                  order by on_.nspname || '.' || oc.relname)
                from pg_dist_partition o
                join pg_class oc on oc.oid = o.logicalrelid
                join pg_namespace on_ on on_.oid = oc.relnamespace
                where o.colocationid = p.colocationid) end as colocated,
              (select count(*)::int from pg_dist_shard s
                where s.logicalrelid = p.logicalrelid) as shards,
              (select array_agg(coalesce(s.shardminvalue, '') || '..' || coalesce(s.shardmaxvalue, '')
                  order by s.shardminvalue::bigint nulls first)
                from pg_dist_shard s where s.logicalrelid = p.logicalrelid) as ranges
            from pg_dist_partition p
            join pg_class c on c.oid = p.logicalrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = any(${names}::text[])
            order by 1`)
        : [],
  };
}
