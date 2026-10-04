#!/usr/bin/env bash
# One-shot Kafka topic bootstrapper: the `kafka-init` compose service (apache/kafka image).
# Reads $TOPICS_FILE lines `name:partitions:replication-factor[:k=v,k=v]`, creates each topic with
# --if-not-exists (idempotent: safe on every `docker compose up`), then asserts that all exist.
set -euo pipefail

BOOTSTRAP="${KAFKA_BOOTSTRAP_SERVERS:-kafka:9092}"
KAFKA_BIN="${KAFKA_BIN:-/opt/kafka/bin}"
TOPICS_FILE="${TOPICS_FILE:-/opt/kafka-init/topics.txt}"
# The CLI tools inherit KAFKA_HEAP_OPTS: keep each short-lived JVM small. Never inherit JMX_PORT
# (every CLI JVM would try to bind it).
export KAFKA_HEAP_OPTS="${KAFKA_INIT_HEAP_OPTS:--Xms32m -Xmx128m}"
unset JMX_PORT KAFKA_JMX_OPTS || true

echo "[kafka-init] waiting for ${BOOTSTRAP} ..."
for i in $(seq 1 60); do
  if "${KAFKA_BIN}/kafka-broker-api-versions.sh" --bootstrap-server "${BOOTSTRAP}" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 60 ] && { echo "[kafka-init] broker not reachable" >&2; exit 1; }
  sleep 2
done

expected=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"; line="$(echo "$line" | tr -d '[:space:]')"
  [ -z "$line" ] && continue
  IFS=':' read -r name partitions rf configs <<< "$line"
  expected+=("${name}")
  args=(--bootstrap-server "${BOOTSTRAP}" --create --if-not-exists --topic "${name}"
        --partitions "${partitions:-3}" --replication-factor "${rf:-1}")
  if [ -n "${configs:-}" ]; then
    IFS=',' read -ra kvs <<< "${configs}"
    for kv in "${kvs[@]}"; do args+=(--config "${kv}"); done
  fi
  echo "[kafka-init] ensure topic ${name} (partitions=${partitions:-3}, rf=${rf:-1}${configs:+, ${configs}})"
  if ! out="$("${KAFKA_BIN}/kafka-topics.sh" "${args[@]}" 2>&1)"; then
    echo "${out}" >&2; exit 1
  fi
  # Topic names contain '.', which triggers a harmless metric-name collision warning.
  printf '%s\n' "${out}" | grep -v -E "Due to limitations in metric names|collide" || true
done < "${TOPICS_FILE}"

present="$("${KAFKA_BIN}/kafka-topics.sh" --bootstrap-server "${BOOTSTRAP}" --list)"
missing=0
for name in "${expected[@]}"; do
  if ! grep -qxF "${name}" <<< "${present}"; then
    echo "[kafka-init] topic ${name} is missing after creation" >&2; missing=1
  fi
done
[ "${missing}" -eq 0 ] || exit 1
echo "[kafka-init] ${#expected[@]} topics present:"
printf '  %s\n' "${expected[@]}"
