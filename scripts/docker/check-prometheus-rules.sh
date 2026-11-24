#!/usr/bin/env bash
# Checks the Prometheus alert rules with promtool, in the Prometheus image docker-compose.yml pins:
# `promtool check rules` on every docker/prometheus/rules/*.rules.yml, then `promtool test rules`
# on every docker/prometheus/tests/*.test.yml. Used by CI's compose job; it starts one throwaway
# container (--rm) and touches nothing else. Usage: scripts/docker/check-prometheus-rules.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

# The tag of the compose `prometheus` service, so the rules are tested by the version that runs them.
images="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*(prom\/prometheus:[^[:space:]]+)[[:space:]]*$/\1/p' docker-compose.yml)"
if [ "$(printf '%s\n' "${images}" | sed '/^$/d' | wc -l | tr -d ' ')" != 1 ]; then
  printf 'FAIL  expected exactly one prom/prometheus image in docker-compose.yml, found: %s\n' \
    "${images:-none}" >&2
  exit 1
fi
image="${images}"

shopt -s nullglob
rules=(docker/prometheus/rules/*.rules.yml)
tests=(docker/prometheus/tests/*.test.yml)
if [ "${#rules[@]}" -eq 0 ] || [ "${#tests[@]}" -eq 0 ]; then
  printf 'FAIL  no rule files or no promtool test files under docker/prometheus\n' >&2
  exit 1
fi

# Inside the container the directory is /w, so a test file's `../rules/*.yml` resolves as on disk.
printf 'promtool from %s\n' "${image}"
docker run --rm -v "${PWD}/docker/prometheus:/w:ro" --entrypoint promtool "${image}" \
  check rules "${rules[@]/#docker\/prometheus//w}"
docker run --rm -v "${PWD}/docker/prometheus:/w:ro" --entrypoint promtool "${image}" \
  test rules "${tests[@]/#docker\/prometheus//w}"
