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
  "citus"
  "monolith,citus"
  "microservices,citus"
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
# B3: PgBouncer is infra (no profile), and every app that runs the database connects as the three
# roles (SH section 5): runtime and system pooled, owner direct, no URL shared between them.
config="$(COMPOSE_PROFILES='*' docker compose -f "${FILE}" config --format json)"
if ! node -e '
  const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const bad = [];
  const pooler = c.services.pgbouncer;
  if (!pooler) bad.push("service pgbouncer missing");
  else if ((pooler.profiles ?? []).length > 0) bad.push("pgbouncer must have no profile");
  for (const name of ["monolith", "identity-service", "billing-service", "ai-service"]) {
    const e = c.services[name]?.environment ?? {};
    const user = (key) => (e[key] ?? "").replace(/^postgres:\/\/([^:]+):.*@([^/]+)\/.*$/, "$1@$2");
    if (user("DATABASE_URL") !== "app_runtime@pgbouncer:6432") bad.push(name + ": DATABASE_URL");
    if (user("DATABASE_SYSTEM_URL") !== "app_system@pgbouncer:6432") bad.push(name + ": DATABASE_SYSTEM_URL");
    if (user("DATABASE_MIGRATION_URL") !== "app_owner@postgres:5432") bad.push(name + ": DATABASE_MIGRATION_URL");
    if (e.DATABASE_POOLER !== "pgbouncer") bad.push(name + ": DATABASE_POOLER");
    if (e.DATABASE_BOOT_GUARD !== "enforce") bad.push(name + ": DATABASE_BOOT_GUARD");
    if (!c.services[name]?.depends_on?.pgbouncer) bad.push(name + ": depends_on pgbouncer");
  }
  if (bad.length) { console.error("three-role wiring: " + bad.join("; ")); process.exit(1); }
' <<<"${config}"; then
  status=1
else
  echo "ok    three-role wiring (pgbouncer, DATABASE_URL / _SYSTEM_URL / _MIGRATION_URL)"
fi
# B3 (SH-11): single node is the default. The worker and its one-shot job exist only under the `citus`
# profile, where infra-ready waits for the job; no host port is published for the worker.
for profiles in "" citus; do
  config="$(COMPOSE_PROFILES="${profiles}" docker compose -f "${FILE}" config --format json)"
  if ! PROFILES="${profiles}" node -e '
    const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const on = process.env.PROFILES === "citus";
    const bad = [];
    for (const name of ["postgres-worker-1", "citus-init"]) {
      if (on !== (name in c.services)) bad.push(name + (on ? " missing" : " present") + " without the profile");
    }
    if (on) {
      const worker = c.services["postgres-worker-1"];
      if ((worker.ports ?? []).length > 0) bad.push("the worker publishes a host port");
      if (!c.services["infra-ready"].depends_on?.["citus-init"]) bad.push("infra-ready must wait for citus-init");
    } else if (c.services["infra-ready"].depends_on?.["citus-init"]?.required !== false) {
      bad.push("without the profile infra-ready must treat citus-init as optional (required: false)");
    }
    if (bad.length) { console.error("citus profile: " + bad.join("; ")); process.exit(1); }
  ' <<<"${config}"; then
    status=1
  else
    echo "ok    citus profile ${profiles:-off}: worker and citus-init as expected"
  fi
done
exit "${status}"
