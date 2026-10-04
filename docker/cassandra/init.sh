#!/bin/sh
# One-shot Cassandra bootstrapper: the `cassandra-init` compose service (cassandra image, for cqlsh).
# Creates the application keyspace idempotently. Tables are NOT created here: every service that
# uses Cassandra runs its own versioned CQL migrations at boot (@app/cassandra CqlMigrator, LWT-locked).
#
#   CASSANDRA_KEYSPACE            keyspace name (same variable the apps read; default "app")
#   CASSANDRA_DC                  data-center name; MUST equal the apps' CASSANDRA_LOCAL_DC
#   CASSANDRA_REPLICATION_FACTOR  replicas in that DC (1 for a single local node)
set -eu

HOST="${CASSANDRA_HOST:-cassandra}"
PORT="${CASSANDRA_NATIVE_PORT:-9042}"
KEYSPACE="${CASSANDRA_KEYSPACE:-app}"
DC="${CASSANDRA_DC:-datacenter1}"
RF="${CASSANDRA_REPLICATION_FACTOR:-1}"

# The keyspace is interpolated into CQL: accept the same identifier the app config accepts.
if ! printf '%s' "${KEYSPACE}" | grep -Eq '^[A-Za-z][A-Za-z0-9_]{0,47}$'; then
  echo "[cassandra-init] invalid CASSANDRA_KEYSPACE '${KEYSPACE}'" >&2
  exit 1
fi
case "${RF}" in '' | *[!0-9]*) echo "[cassandra-init] invalid CASSANDRA_REPLICATION_FACTOR" >&2; exit 1 ;; esac

cql() { cqlsh "${HOST}" "${PORT}" --request-timeout=60 "$@"; }

echo "[cassandra-init] waiting for ${HOST}:${PORT} ..."
i=0
until cql -e 'SELECT release_version FROM system.local' >/dev/null 2>&1; do
  i=$((i + 1))
  [ "${i}" -ge 60 ] && { echo "[cassandra-init] cassandra not reachable" >&2; exit 1; }
  sleep 2
done

# NetworkTopologyStrategy even on one node: production uses it, and the DC name is checked early
# (a wrong DC = every query fails with "no host available" once the driver filters by local DC).
cql -e "CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
  WITH replication = {'class': 'NetworkTopologyStrategy', '${DC}': ${RF}}
  AND durable_writes = true;"

actual_dc="$(cql -e 'SELECT data_center FROM system.local' | sed -n '4p' | tr -d '[:space:]')"
if [ "${actual_dc}" != "${DC}" ]; then
  echo "[cassandra-init] node data center is '${actual_dc}', expected '${DC}' (CASSANDRA_LOCAL_DC)" >&2
  exit 1
fi

cql -e "DESCRIBE KEYSPACE ${KEYSPACE}" | grep -m1 'CREATE KEYSPACE'
echo "[cassandra-init] keyspace ${KEYSPACE} ready (dc=${DC}, rf=${RF})"
