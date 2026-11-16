-- Runs ONCE, on an empty data directory only (docker-entrypoint-initdb.d semantics), before
-- 01-extensions.sql (the entrypoint runs the files in name order).
-- citusdata/citus ships its own /docker-entrypoint-initdb.d/001-create-citus-extension.sql, but
-- docker-compose.yml mounts this folder over that directory, so the extension is created here.
-- Single node needs no other setup: the first create_distributed_table registers this server as
-- the node that holds every shard (sharding design, P-11).
CREATE EXTENSION IF NOT EXISTS citus;
