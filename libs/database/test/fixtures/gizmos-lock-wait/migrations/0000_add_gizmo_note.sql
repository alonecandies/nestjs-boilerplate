-- Takes ACCESS EXCLUSIVE on gizmos.gizmos and, on Citus, on every shard (over the connections the
-- coordinator opens to the workers): blocked by any open transaction that read one of them.
ALTER TABLE "gizmos"."gizmos" ADD COLUMN "note" text;
