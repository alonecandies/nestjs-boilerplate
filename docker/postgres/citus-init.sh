#!/bin/sh
# One-shot job of the compose profile `citus` (sharding design section 9): joins postgres-worker-1 to the
# coordinator. Idempotent: every step looks at pg_dist_node first, so a second run (for example
# `docker compose --profile citus run --rm citus-init` after the apps migrated) changes nothing
# unless something is left to move.
#
#   1. the coordinator is registered under its service name: a single-node coordinator may sit in
#      the metadata as "localhost", which Citus refuses to combine with workers;
#   2. the worker is added (Citus copies the roles' objects and the reference tables to it);
#   3. the coordinator stops holding shards (new tenant shards land on the worker) and whatever it
#      still holds, from a volume that ran single node, is drained to the worker. block_writes:
#      the compose coordinator does not run with wal_level=logical.
set -eu

: "${PGHOST:=postgres}"
: "${PGUSER:=app}"
: "${PGDATABASE:=app}"
: "${COORDINATOR_HOST:=postgres}"
: "${WORKER_HOST:=postgres-worker-1}"
export PGHOST PGUSER PGDATABASE

psql -v ON_ERROR_STOP=1 -v coordinator="${COORDINATOR_HOST}" -v worker="${WORKER_HOST}" <<'SQL'
select case
  when not exists (select 1 from pg_dist_node where groupid = 0)
    then citus_set_coordinator_host(:'coordinator', 5432)::text
  when exists (select 1 from pg_dist_node where groupid = 0 and nodename <> :'coordinator')
    then (select citus_update_node(nodeid, :'coordinator', 5432)::text
            from pg_dist_node where groupid = 0)
  else 'coordinator already registered as ' || :'coordinator'
end as coordinator;

select case
  when exists (select 1 from pg_dist_node where nodename = :'worker' and nodeport = 5432)
    then 'worker already added'
  else citus_add_node(:'worker', 5432)::text
end as worker;

select citus_set_node_property(:'coordinator', 5432, 'shouldhaveshards', false);
select replicate_reference_tables(shard_transfer_mode => 'block_writes');
select rebalance_table_shards(drain_only => true, shard_transfer_mode => 'block_writes');

select nodeid, groupid, nodename, nodeport, shouldhaveshards from pg_dist_node order by groupid;
SQL
