#!/usr/bin/env bash
# Boots the default (infra-only) compose stack in an ISOLATED project, asserts that every
# bootstrap step really happened, prints resource usage, then removes the project (containers,
# network, volumes). Used by CI; locally it never touches another compose project.
#
#   scripts/docker/check-infra.sh                 # project "bp-infra-check"
#   PROJECT=my-check KEEP=1 scripts/docker/check-infra.sh   # keep the stack running afterwards
# Host ports can be remapped with the usual *_HOST_PORT variables (see .env.example) when the
# defaults are taken.
set -euo pipefail

cd "$(dirname "$0")/../.."
PROJECT="${PROJECT:-bp-infra-check}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-420}"
compose() { COMPOSE_PROFILES='' docker compose -p "${PROJECT}" "$@"; }
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
for svc in kafka-init cassandra-init storage-init; do
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

log "postgres: extensions + native uuidv7()"
exts="$(compose exec -T postgres psql -U "${POSTGRES_USER:-app}" -d "${POSTGRES_DB:-app}" -tAc \
  "select string_agg(extname, ',' order by extname) from pg_extension")"
for ext in pg_stat_statements pg_trgm; do
  [[ ",${exts}," == *",${ext},"* ]] || fail "extension ${ext} missing (have: ${exts})"
done
version="$(compose exec -T postgres psql -U "${POSTGRES_USER:-app}" -d "${POSTGRES_DB:-app}" -tAc \
  "select current_setting('server_version') || ' uuidv7=' || uuidv7()")"
echo "  extensions: ${exts}; ${version}"

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
  "cassandra:${CASSANDRA_HOST_PORT:-9042}" "kafka:${KAFKA_HOST_PORT:-9094}" \
  "mailpit-smtp:${MAILPIT_SMTP_HOST_PORT:-1025}" "mailpit-ui:${MAILPIT_UI_HOST_PORT:-8025}" \
  "s3:${S3_HOST_PORT:-9000}" "gcs:${GCS_HOST_PORT:-4443}"; do
  (exec 3<>"/dev/tcp/127.0.0.1/${pair#*:}") 2>/dev/null || fail "${pair%%:*} not reachable on 127.0.0.1:${pair#*:}"
  echo "  ${pair%%:*} 127.0.0.1:${pair#*:} open"
done

log "resource usage (docker compose stats)"
compose stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' || true

log "OK: infra stack verified in $(($(date +%s) - start))s"
