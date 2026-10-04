#!/usr/bin/env bash
# Validates docker-compose.yml for every supported profile combination (`docker compose config -q`:
# schema, interpolation, anchors/merges, depends_on targets). Used by CI; safe to run anywhere
# (it starts nothing). Usage: scripts/docker/validate-compose.sh [compose file]
set -euo pipefail

cd "$(dirname "$0")/../.."
FILE="${1:-docker-compose.yml}"

combos=(
  ""                                              # infra only
  "monolith"
  "microservices"
  "observability"
  "logs"
  "tools"
  "loadtest"
  "monolith,observability,logs,tools,loadtest"
  "microservices,observability,logs,tools,loadtest"
  "*"
)

status=0
for profiles in "${combos[@]}"; do
  label="${profiles:-<none>}"
  if out="$(COMPOSE_PROFILES="${profiles}" docker compose -f "${FILE}" config -q 2>&1)"; then
    printf 'ok    profiles=%s\n' "${label}"
  else
    printf 'FAIL  profiles=%s\n%s\n' "${label}" "${out}" >&2
    status=1
  fi
done

# The API alias/host port must belong to exactly one topology per profile.
for topology in monolith microservices; do
  api="$(COMPOSE_PROFILES="${topology}" docker compose -f "${FILE}" config --format json |
    node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));
      console.log(Object.entries(c.services).filter(([,s])=>(s.networks?.backend?.aliases??[]).includes("api")).map(([n])=>n).join(","))')"
  printf 'ok    profile %-13s -> api alias: %s\n' "${topology}" "${api}"
  [ -n "${api}" ] && [[ "${api}" != *,* ]] || { echo "expected exactly one 'api' service" >&2; status=1; }
done
exit "${status}"
