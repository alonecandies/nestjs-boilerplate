# Operations: backup and restore

How each store is backed up and restored, in what order, and what losing one store means for the others.
Related: [Security](SECURITY.md#production-checklist) · [Docker](DOCKER.md) · [Configuration](CONFIGURATION.md) ·
[Observability](OBSERVABILITY.md) · [billing README](../domains/billing/README.md#ledger-immudb).

## How to read this page

- **UNTESTED** marks every step that was not run end to end in this repository. Commands were checked against the
  pinned images' CLIs (Citus 14.2.0 on PostgreSQL 18.4, Cassandra 5.0.9, immudb 1.11.2); no backup was taken and
  restored through them. Rehearse each procedure on a copy of your data before you need it, and write down the
  time it took.
- The local compose stack is not a production setup ([DOCKER.md](DOCKER.md#what-is-local-only-dont-ship-this-compose-file)).
  Backing up its volumes is only useful for a development database you want to keep.
- Not covered here: Kafka (topics are rebuilt from `docker/kafka/topics.txt`; retention decides what a consumer can
  replay), object storage (use the provider's versioning) and Redis (persist it with AOF; see the Redis item of the
  [production checklist](SECURITY.md#production-checklist)).

| Store            | Holds                                                              | Backup                                          | Loss window is              |
| ---------------- | ------------------------------------------------------------------ | ----------------------------------------------- | --------------------------- |
| Postgres / Citus | identity, billing and ai schemas, outbox rows, the ledger receipts | base backup plus WAL archive, per node          | since the last archived WAL |
| immudb           | the money ledger (append-only; Stripe is the source of the data)   | `immuadmin hot-backup`, or synchronous replicas | since the last backup       |
| Cassandra        | the notifications inbox                                            | `nodetool snapshot`, per node                   | since the last snapshot     |

## Postgres and Citus

One logical database spread over a coordinator and, with the Citus workers, several nodes. A restore is only
consistent when every node recovers to the same point.

**Backup.**

1. A base backup of the coordinator and of every worker (`pg_basebackup`, or your backup tool: pgBackRest, WAL-G,
   a volume snapshot taken with the server in backup mode). UNTESTED.
2. Continuous WAL archiving on every node (`archive_mode = on`, `archive_command` to durable storage off the
   node). Without the WAL archive, a restore can only return to the base backup. UNTESTED.
3. Before each release (and before any migration that rewrites data), on the coordinator as a superuser:

   ```sql
   select citus_create_restore_point('before-release-2026-11-23');
   ```

   It returns an LSN and writes a named restore point into the WAL of the coordinator and of every worker; the
   call itself was run against a coordinator with one worker. Keep the name in the release notes: it is the
   target of step 3 of the restore.

**Restore.** UNTESTED end to end.

1. Stop every app, the migration job and PgBouncer, so nothing writes while the nodes recover.
2. On every node, restore its own base backup into an empty data directory, and set the same target in
   `postgresql.conf`/`recovery` settings: `recovery_target_name = 'before-release-2026-11-23'` (or one
   `recovery_target_time` that every node's WAL covers), `recovery_target_action = 'promote'`, plus the
   `restore_command` for the WAL archive.
3. Start the workers first, then the coordinator. Check that `select * from pg_dist_node` on the coordinator still
   lists the workers' host names and ports; if a worker came back on a new address, repair the entry with
   `citus_update_node`.
4. Compare `<schema>.__drizzle_migrations` with the release you are about to run. Do not start the apps with
   `DATABASE_RUN_MIGRATIONS=true` against a database restored from before a migration you did not intend to
   re-run; run the release job on purpose instead.
5. Start PgBouncer and the apps. Then read the restore order below: the other stores may now be ahead of
   Postgres.

**What a Postgres loss window does.** Rows written after the recovery point are gone: payments, the Stripe event
receipts, outbox rows and, for money, the receipts in `billing.ledger_entry_refs`. Events that the outbox had
already published are in Kafka, so consumers see events for state that no longer exists; consumers deduplicate on
the envelope id, they do not undo. Money is recovered from Stripe, not from Postgres: see the loss windows below.

## Cassandra

Holds only the notifications inbox, so it is the least coupled store. Take a snapshot on **every** node: a snapshot
is node-local.

**Backup.** UNTESTED.

```bash
nodetool snapshot -t before-release-2026-11-23 <keyspace>     # hard links in each table's snapshots/ directory
# optional: --ttl <duration> lets Cassandra clear the snapshot itself
```

Copy each snapshot directory off the node, together with the schema (`DESCRIBE KEYSPACE` output, or the
`schema.cql` Cassandra writes into the snapshot), then clear it with `nodetool clearsnapshot -t <tag>`. A snapshot
holds the data of that moment only; take them on a cadence shorter than the inbox loss you accept.

**Restore.** UNTESTED. The keyspace and tables must exist with the same schema (the apps create them at boot with
`CASSANDRA_RUN_MIGRATIONS=true`, or recreate them from the saved schema).

- Same cluster shape: stop the notifications consumers, put each node's snapshot files in the table directories of
  that node and run `nodetool import <keyspace> <table> <directory>` (or `nodetool refresh <keyspace> <table>`
  after copying into the data directory).
- Different cluster shape, or a different token layout: stream the sstables in with `sstableloader`
  (`-d <contact points> <path>/<keyspace>/<table>`), which writes them through the live ring.
- Then run `nodetool repair` so replicas agree.

**What a Cassandra loss window does.** Inbox rows created after the snapshot are gone, and the Kafka consumer
group has already moved past the events that created them. They are not rebuilt unless you reset the group's
offsets to the snapshot time (`kafka-consumer-groups.sh --reset-offsets --to-datetime …`) while the notifications
consumers are stopped; the consumers deduplicate on the envelope id, and Kafka retention bounds how far back this
works. UNTESTED. Pushes and mails for those events are sent again by such a replay. Postgres and immudb do not
depend on this store.

## immudb

The ledger is append-only and cannot be edited: a backup is a copy of a history, and a restore returns to an older
history. Apps pin the server's signing key and `billing.ledger_trusted_state` remembers the last verified state, so
a restore needs a step after the data comes back (the re-anchor below).

**Backup.** UNTESTED. Pick one, sized to the loss you accept:

- A hot backup on a cadence shorter than that loss, with the server running:

  ```bash
  immuadmin hot-backup <database> -o <file>                  # first full file
  immuadmin hot-backup <database> -o <file> --start-tx <n>   # later: continue after a transaction already saved
  ```

  `--start-tx` starts the file at a transaction id, so a later backup need not copy the whole history again.
  Keep the files off the immudb host. The loss window is the time since the last file.

- Or synchronous replication: run a replica and start the primary with `--replication-sync-enabled` and
  `--replication-sync-acks <n>`. A transaction is then acknowledged only after `n` replicas have it, so a lost
  primary loses nothing that was acknowledged. A replica is a second copy, not a backup: it also copies a
  mistake, so keep the hot backups too.

- `immuadmin backup` (pause the server, copy the data directory, resume) also exists; it stops writes while it
  copies, and the pinned image has no shell, so run `immuadmin` from another container or the host, against the
  server's admin port.

The private signing key (`--signingKey`) is not part of the data. Back it up with your secret store, and restore
the server **with the same key**: the apps pin the public key ([SECURITY.md](SECURITY.md#immudb-state-signing-key)).

**Restore.** UNTESTED end to end.

1. Stop billing-service (or the monolith), so no posting or reconcile run races the restore.
2. Start a fresh immudb with the same `--signingKey` and an empty data directory, create the ledger database, then
   check a file without writing it:

   ```bash
   immuadmin hot-restore <database> -i <file> --verify-only
   immuadmin hot-restore <database> -i <file>                 # add --append to apply a later file on top
   ```

   Or, from `immuadmin backup`, copy the saved data directory back with the server stopped.

3. Start the apps. The next reconciliation reports `verification_failed` from R5 when the restored history is
   shorter than the trusted state: that is the intended alarm, and it does not advance on its own. Do not clear or
   edit `billing.ledger_trusted_state` by hand.
4. Re-anchor the trusted state with the audited command. It refuses without a pinned signing key, with an invalid
   state signature, with the ledger off, and when the restored state still extends the trusted one (nothing lost,
   nothing to re-anchor). `LEDGER_ALLOW_UNVERIFIED` does not bypass it.

   ```bash
   node dist/cli/ledger-reanchor.js \
     --database <ledger database> \
     --lost-from <ISO time: the start of the history that was lost> \
     --operator <who runs it> \
     --reason "<why>"
   ```

   The entrypoint is in the monolith and billing-service images. It records an audit row
   (`billing.ledger_reanchors`) and the new state in one transaction, then runs one reconciliation over
   `[lost-from, now)`.

5. That first reconciliation reports the entries missing from the restored ledger as `verification_failed`
   and re-enqueues them (R4), and the posting path posts each one once, so the ledger holds one entry per source
   again. The next run is clean. Check `ledger_reconciliation_runs_total`, the `LedgerReconciliationStale` alert
   and the discrepancy rows ([OBSERVABILITY.md](OBSERVABILITY.md#outbox-ledger-and-ai-alerts)).

`--lost-from` matters: R4 looks at Stripe's balance transactions only inside the window it is given (72 hours back
by default, `LEDGER_RECONCILE_LOOKBACK_HOURS`), so a loss older than that is not re-posted unless the window
covers it. Set it to the time of the oldest entry the backup lacks, or earlier.

## Restore order and loss windows

Restore in this order, and stop at the first store that did not need it:

1. **Postgres and Citus first.** Every other store is read through Postgres state (payments, receipts, outbox).
   Bring up the database, the roles and PgBouncer, with the apps still stopped.
2. **immudb second, then the re-anchor.** The ledger is checked against Postgres receipts, so Postgres comes first.
   Restore the data, start billing-service, run the re-anchor, and let one reconciliation finish.
3. **Cassandra at any time.** It shares no data with the others and can be restored before, after or in parallel.
4. Start the rest of the apps and check `/health/ready`.

What each store's loss window means for the others:

| Lost                                     | Effect on the others                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres newer rows (immudb is ahead)    | immudb has entries whose receipts in `billing.ledger_entry_refs` are gone. R4 lists the Stripe transactions without a receipt and re-enqueues them; posting finds the entry already in immudb by its id (`replayed`) and records a receipt without a tx id, not a second entry (read from the code, UNTESTED at runtime). The trusted state is below immudb's, so R5 advances normally. |
| immudb newer entries (Postgres is ahead) | Receipts point at entries the restored ledger lacks and the trusted state is above its tip. Re-anchor with `--lost-from` at the start of the gap; reconciliation then re-posts what Stripe lists in that window.                                                                                                                                                                        |
| Both, to different points                | Treat it as the immudb case, with `--lost-from` at the earlier point, and expect payments and receipts after the Postgres point to be recovered from Stripe by hand: resend the webhook events from the Stripe dashboard.                                                                                                                                                               |
| Cassandra                                | Only the inbox: see above. No money and no identity data.                                                                                                                                                                                                                                                                                                                               |

After any restore, write down the recovery point you used for each store, the time the restore took and what you had
to re-run, and keep it with the incident notes.
