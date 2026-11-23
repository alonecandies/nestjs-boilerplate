#!/usr/bin/env bash
# Boots the default (infra-only) compose stack in an ISOLATED project, asserts that every
# bootstrap step really happened, prints resource usage, then removes the project (containers,
# network, volumes). Used by CI; locally it never touches another compose project.
#
#   scripts/docker/check-infra.sh                 # project "bp-infra-check"
#   PROJECT=my-check KEEP=1 scripts/docker/check-infra.sh   # keep the stack running afterwards
#   CITUS=1 scripts/docker/check-infra.sh         # the `citus` profile too: coordinator + one worker
# Host ports can be remapped with the usual *_HOST_PORT variables (see .env.example) when the
# defaults are taken.
set -euo pipefail

cd "$(dirname "$0")/../.."
PROJECT="${PROJECT:-bp-infra-check}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-420}"
# The infra-only stack, or with CITUS=1 the `citus` profile on top (postgres-worker-1, citus-init).
PROFILES=''
[ "${CITUS:-0}" = 1 ] && PROFILES='citus'
compose() { COMPOSE_PROFILES="${PROFILES}" docker compose -p "${PROJECT}" "$@"; }
log() { printf '\n\033[1m[check-infra] %s\033[0m\n' "$*"; }
fail() { printf '\033[31m[check-infra] FAIL: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  local code=$?
  if [ "${code}" -ne 0 ]; then
    log "logs of failed/unhealthy services"
    compose ps -a || true
    compose logs --no-color --tail 40 || true
  fi
  if [ "${KEEP:-0}" = 1 ]; then
    log "KEEP=1: leaving project ${PROJECT} running (docker compose -p ${PROJECT} down -v)"
  else
    log "tearing down project ${PROJECT}"
    compose down -v --remove-orphans --timeout 20 >/dev/null 2>&1 || true
  fi
  exit "${code}"
}
trap cleanup EXIT

start=$(date +%s)
log "docker compose -p ${PROJECT} up -d --wait (timeout ${WAIT_TIMEOUT}s)"
compose up -d --wait --wait-timeout "${WAIT_TIMEOUT}"
log "stack healthy after $(($(date +%s) - start))s"

log "one-shot init containers exited 0"
inits=(kafka-init cassandra-init storage-init immudb-keygen grpc-principal-keygen immudb-init)
[ "${CITUS:-0}" = 1 ] && inits+=(citus-init)
for svc in "${inits[@]}"; do
  cid="$(compose ps -a -q "${svc}")"
  [ -n "${cid}" ] || fail "${svc} never ran"
  state="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "${cid}")"
  [ "${state}" = "exited 0" ] || fail "${svc}: ${state}"
  echo "  ${svc}: ${state}"
done

log "kafka: every topic of docker/kafka/topics.txt exists; auto-creation is off"
topics="$(compose exec -T -e KAFKA_HEAP_OPTS=-Xmx96m kafka \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list)"
while IFS= read -r line; do
  name="$(printf '%s' "${line%%#*}" | tr -d '[:space:]' | cut -d: -f1)"
  [ -z "${name}" ] && continue
  grep -qxF "${name}" <<<"${topics}" || fail "topic ${name} missing"
  # </dev/null: `exec -T` would otherwise consume the rest of topics.txt from the loop's stdin.
  partitions="$(compose exec -T -e KAFKA_HEAP_OPTS=-Xmx96m kafka /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server localhost:9092 --describe --topic "${name}" </dev/null | grep -c 'Partition: ' || true)"
  echo "  ${name} (${partitions} partitions)"
done <docker/kafka/topics.txt
auto="$(compose exec -T -e KAFKA_HEAP_OPTS=-Xmx96m kafka /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server localhost:9092 --entity-type brokers --entity-name 1 --describe --all |
  grep -o 'auto.create.topics.enable=[a-z]*' | head -1)"
[ "${auto}" = "auto.create.topics.enable=false" ] || fail "broker ${auto:-auto.create.topics.enable=?}"
echo "  ${auto}"

log "cassandra: keyspace ${CASSANDRA_KEYSPACE:-app} replicated in ${CASSANDRA_DC:-datacenter1}"
ks="$(compose exec -T cassandra cqlsh -e "DESCRIBE KEYSPACE ${CASSANDRA_KEYSPACE:-app}" | grep -m1 'CREATE KEYSPACE')"
grep -q "'${CASSANDRA_DC:-datacenter1}': '1'" <<<"${ks}" || fail "unexpected keyspace: ${ks}"
echo "  ${ks}"

log "postgres: Citus single node, extensions + native uuidv7()"
psql_app() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-app}" -d "${POSTGRES_DB:-app}" -tAc "$1"
}
preload="$(psql_app "show shared_preload_libraries")"
[[ "${preload}" == citus,* ]] || fail "shared_preload_libraries must start with citus (have: ${preload})"
exts="$(psql_app "select string_agg(extname, ',' order by extname) from pg_extension")"
for ext in citus pg_stat_statements pg_trgm; do
  [[ ",${exts}," == *",${ext},"* ]] || fail "extension ${ext} missing (have: ${exts})"
done
version="$(psql_app "select current_setting('server_version') || ' uuidv7=' || uuidv7() \
  || ' shard_count=' || current_setting('citus.shard_count') || ' ' || citus_version()")"
echo "  preload: ${preload}; extensions: ${exts}; ${version}"

log "postgres roles: app_owner / app_runtime / app_system"
roles="$(psql_app "select string_agg(rolname || ':' || rolsuper::int || rolbypassrls::int, ',' order by rolname) \
  from pg_roles where rolname in ('app_owner','app_runtime','app_system')")"
[ "${roles}" = "app_owner:00,app_runtime:00,app_system:01" ] || fail "roles (name:super,bypassrls): ${roles}"
echo "  ${roles}"

if [ "${CITUS:-0}" = 1 ]; then
  log "citus profile: coordinator + one worker, roles on both, shards on the worker"
  nodes="$(psql_app "select string_agg(groupid || ':' || nodename || ':' || shouldhaveshards::int, ',' order by groupid) \
    from pg_dist_node")"
  [ "${nodes}" = "0:postgres:0,1:postgres-worker-1:1" ] || fail "pg_dist_node (group:host:shouldhaveshards): ${nodes}"
  echo "  pg_dist_node: ${nodes}"
  # Every direction of the cluster: coordinator and worker, each to each (4 pairs for 2 nodes).
  health="$(psql_app "select count(*) filter (where result) || '/' || count(*) from citus_check_cluster_node_health()")"
  [ "${health}" = 4/4 ] || fail "citus_check_cluster_node_health(): ${health} pairs reachable"
  echo "  citus_check_cluster_node_health(): ${health}"
  worker_roles="$(psql_app "select result from run_command_on_workers(\$\$select string_agg(rolname || ':' || rolsuper::int \
    || rolbypassrls::int, ',' order by rolname) from pg_roles where rolname in ('app_owner','app_runtime','app_system')\$\$)")"
  [ "${worker_roles}" = "app_owner:00,app_runtime:00,app_system:01" ] || fail "roles on the worker: ${worker_roles}"
  echo "  roles on the worker: ${worker_roles}"
  # A throwaway distributed table: all of its shards must land on the worker, none on the coordinator.
  psql_app "create table public.citus_probe (tenant_id uuid primary key)" >/dev/null
  psql_app "select create_distributed_table('public.citus_probe', 'tenant_id')" >/dev/null
  placed="$(psql_app "select string_agg(nodename || '=' || n, ',' order by nodename) from (select nodename, \
    count(*) n from citus_shards where table_name = 'public.citus_probe'::regclass group by nodename) s")"
  psql_app "drop table public.citus_probe" >/dev/null
  shard_count="$(psql_app "show citus.shard_count")"
  [ "${placed}" = "postgres-worker-1=${shard_count}" ] || fail "citus_probe shards (node=count): ${placed}"
  echo "  citus_probe shards: ${placed}"
fi

log "pgbouncer: transaction pooling, two users, 6432 only for the pooled roles"
# bounce <user> <db> <sql> [PGOPTIONS]: psql inside the pgbouncer container, through its own port.
bounce() {
  compose exec -T -e "PGPASSWORD=$1" -e "PGOPTIONS=${4:-}" pgbouncer \
    psql -h 127.0.0.1 -p 6432 -U "$1" -d "$2" -tAc "$3"
}
db="${POSTGRES_DB:-app}"
[ "$(bounce app_runtime "${db}" 'select current_user')" = app_runtime ] || fail "app_runtime through 6432"
[ "$(bounce app_system "${db}" 'select current_user')" = app_system ] || fail "app_system through 6432"
pools="$(bounce app_system pgbouncer 'show pools' | cut -d'|' -f1-2 | tr '\n' ' ')"
for user in app_runtime app_system; do
  [[ "${pools}" == *"${db}|${user}"* ]] || fail "SHOW POOLS lacks ${user} (have: ${pools})"
done
echo "  SHOW POOLS: ${pools}"
config="$(bounce app_system pgbouncer 'show config')"
mode="$(awk -F'|' '$1=="pool_mode"{print $2}' <<<"${config}")"
[ "${mode}" = transaction ] || fail "pool_mode=${mode}"
ignored="$(awk -F'|' '$1=="ignore_startup_parameters"{print $2}' <<<"${config}")"
[ "${ignored}" = extra_float_digits ] || fail "ignore_startup_parameters=${ignored}"
echo "  pool_mode=${mode} ignore_startup_parameters=${ignored}"
# The roles carry the timeouts (ALTER ROLE ... SET), so the pooler never needs them as parameters.
st="$(bounce app_runtime "${db}" 'show statement_timeout')"
[ "${st}" = 15s ] || fail "app_runtime statement_timeout through PgBouncer is ${st}, want 15s"
# A statement_timeout startup parameter must be refused: it is how the migration runner tells that
# DATABASE_MIGRATION_URL points at a pooler (08P01), so PgBouncer must not be told to ignore it.
if out="$(bounce app_runtime "${db}" 'select 1' '-c statement_timeout=0' 2>&1)"; then
  fail "a statement_timeout startup parameter was accepted through PgBouncer: ${out}"
fi
[[ "${out}" == *"unsupported startup parameter"* ]] || fail "unexpected refusal: ${out}"
echo "  startup parameter statement_timeout refused: $(tr -d '\r' <<<"${out}" | head -1)"
if out="$(bounce app_owner "${db}" 'select 1' 2>&1)"; then
  fail "app_owner logged in through PgBouncer: ${out}"
fi
echo "  app_owner through 6432 refused: $(tr -d '\r' <<<"${out}" | head -1)"

log "redis: reachable from another container WITHOUT a password; BullMQ-safe eviction policy"
network="$(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT}" | head -1)"
[ -n "${network}" ] || fail "compose network not found"
pong="$(docker run --rm --network "${network}" redis:8.10.2-alpine3.23 redis-cli -h redis ping)"
[ "${pong}" = PONG ] || fail "redis ping from the network: ${pong}"
policy="$(compose exec -T redis redis-cli config get maxmemory-policy | tail -1)"
[ "${policy}" = noeviction ] || fail "maxmemory-policy=${policy}"
echo "  ping=${pong} maxmemory-policy=${policy}"

log "object storage: bucket 'uploads' in RustFS (S3) and fake-gcs"
s3="$(compose exec -T rustfs curl -s -o /dev/null -w '%{http_code}' -I \
  --aws-sigv4 'aws:amz:us-east-1:s3' --user "${RUSTFS_ACCESS_KEY:-rustfsadmin}:${RUSTFS_SECRET_KEY:-rustfsadmin}" \
  http://127.0.0.1:9000/uploads)"
[ "${s3}" = 200 ] || fail "S3 HEAD /uploads -> ${s3}"
gcs="$(compose exec -T gcs wget -q -O - http://127.0.0.1:4443/storage/v1/b/uploads)"
grep -q '"name": *"uploads"' <<<"${gcs}" || fail "GCS bucket uploads: ${gcs}"
echo "  s3 HEAD /uploads=${s3}; gcs bucket uploads present"
# Browser presigned uploads: a CORS preflight from the default frontend origin must be allowed.
cors="$(compose exec -T rustfs curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: PUT' \
  http://127.0.0.1:9000/uploads/cors-probe | tr -d '\r' | grep -i '^access-control-allow-origin:' || true)"
[ -n "${cors}" ] || fail "S3 CORS preflight from http://localhost:5173: no Access-Control-Allow-Origin"
echo "  s3 CORS preflight: ${cors}"

log "host ports (127.0.0.1) accept TCP connections"
for pair in "postgres:${POSTGRES_HOST_PORT:-5432}" "redis:${REDIS_HOST_PORT:-6379}" \
  "pgbouncer:${PGBOUNCER_HOST_PORT:-6432}" "cassandra:${CASSANDRA_HOST_PORT:-9042}" "kafka:${KAFKA_HOST_PORT:-9094}" \
  "mailpit-smtp:${MAILPIT_SMTP_HOST_PORT:-1025}" "mailpit-ui:${MAILPIT_UI_HOST_PORT:-8025}" \
  "s3:${S3_HOST_PORT:-9000}" "gcs:${GCS_HOST_PORT:-4443}" "immudb:${IMMUDB_HOST_PORT:-3322}"; do
  (exec 3<>"/dev/tcp/127.0.0.1/${pair#*:}") 2>/dev/null || fail "${pair%%:*} not reachable on 127.0.0.1:${pair#*:}"
  echo "  ${pair%%:*} 127.0.0.1:${pair#*:} open"
done

log "resource usage (docker compose stats)"
compose stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' || true

log "OK: infra stack verified in $(($(date +%s) - start))s"
