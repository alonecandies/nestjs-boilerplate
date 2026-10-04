# Docker, local infrastructure & CI

Everything you need to run the stack locally, build production images, observe the apps and load-test them.
Files: [`Dockerfile`](../Dockerfile), [`.dockerignore`](../.dockerignore), [`docker-compose.yml`](../docker-compose.yml),
[`docker/`](../docker) (service configs), [`scripts/docker/`](../scripts/docker), [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## TL;DR

```bash
docker compose up -d --wait                                  # infra only (Postgres, Redis, Cassandra, Kafka, Mailpit, RustFS, fake-gcs)
bun run dev                                                  # monolith on the HOST against that infra (fastest loop, zero .env)

docker compose --profile monolith up -d --build --wait       # or: the monolith in a container       -> http://localhost:3000
docker compose --profile microservices up -d --build --wait  # or: gateway + identity/notifications/billing -> http://localhost:3000
docker compose --profile observability up -d --wait          # Grafana http://localhost:3300 · Prometheus :9090 · Jaeger :16686
docker compose --profile loadtest run --rm k6                # k6 against http://api:3000 (whichever topology runs)
docker compose --profile '*' down -v                         # stop everything, wipe volumes
```

The root `package.json` wraps the common ones: `bun run docker:infra | docker:monolith | docker:microservices |
docker:observability | docker:down | loadtest`.

Requirements: Docker Desktop / Engine with Compose **v2.24+** (tested with Compose v5.5.1, Engine 29.8) and BuildKit.
Budget: the stack is sized for **4 CPUs / 4 GB** of Docker Desktop memory (see [Resource budget](#resource-budget-4-gb)).

## Stack map

| Service                 | Image                                           | Host port (127.0.0.1)        | Profile             | Purpose                                            |
| ----------------------- | ----------------------------------------------- | ---------------------------- | ------------------- | -------------------------------------------------- |
| `postgres`              | `postgres:18.6-alpine3.24`                      | 5432                         | —                   | identity + billing (Drizzle), db/user/pw `app`     |
| `redis`                 | `redis:8.10.2-alpine3.23`                       | 6379                         | —                   | cache, locks, throttling, BullMQ, pub/sub          |
| `cassandra`             | `cassandra:5.0.9`                               | 9042                         | —                   | notifications inbox (DC `datacenter1`)             |
| `cassandra-init`        | `cassandra:5.0.9` (cqlsh)                       | —                            | —                   | one-shot: keyspace `$CASSANDRA_KEYSPACE`           |
| `kafka`                 | `apache/kafka:4.3.1` (KRaft, single node)       | 9094 (EXTERNAL listener)     | —                   | integration events                                 |
| `kafka-init`            | `apache/kafka:4.3.1` (CLI)                      | —                            | —                   | one-shot: topics from `docker/kafka/topics.txt`    |
| `mailpit`               | `axllent/mailpit:v1.31.3`                       | 1025 (SMTP), 8025 (UI)       | —                   | catches every mail                                 |
| `rustfs`                | `rustfs/rustfs:1.0.0`                           | 9000 (S3), 9001 (console)    | —                   | S3-compatible storage, `rustfsadmin`/`rustfsadmin` |
| `gcs`                   | `fsouza/fake-gcs-server:1.56.1`                 | 4443                         | —                   | GCS emulator (`STORAGE_DRIVER=gcs`)                |
| `storage-init`          | `rustfs/rustfs:1.0.0` (curl)                    | —                            | —                   | one-shot: bucket `uploads` in both                 |
| `infra-ready`           | `redis:8.10.2-alpine3.23` (idle `sleep`)        | —                            | —                   | sentinel for `up --wait` (see below)               |
| `monolith`              | built (`APP=monolith`)                          | 3000                         | monolith            | everything in one process, alias `api`             |
| `gateway`               | built (`APP=gateway`)                           | 3000                         | microservices       | edge (REST/GraphQL/WS), alias `api`                |
| `identity-service`      | built (`APP=identity-service`)                  | 50051 (gRPC)                 | microservices       | AuthService + UsersService                         |
| `notifications-service` | built (`APP=notifications-service`)             | 50052 (gRPC)                 | microservices       | NotificationsService + Kafka consumers + mail      |
| `billing-service`       | built (`APP=billing-service`)                   | 50053 (gRPC)                 | microservices       | BillingService (Stripe)                            |
| `prometheus`            | `prom/prometheus:v3.15.0`                       | 9090                         | observability       | scrapes every app's `/metrics` + exporters         |
| `grafana`               | `grafana/grafana:13.2.2`                        | **3300**                     | observability, logs | dashboards (admin/admin, anonymous viewer)         |
| `jaeger`                | `jaegertracing/jaeger:2.20.0`                   | 16686 (UI), 4317/4318 (OTLP) | observability       | traces (in-memory)                                 |
| `postgres-exporter`     | `prometheuscommunity/postgres-exporter:v0.20.1` | —                            | observability       | Postgres metrics                                   |
| `redis-exporter`        | `oliver006/redis_exporter:v1.92.1-alpine`       | —                            | observability       | Redis metrics                                      |
| `loki` / `alloy`        | `grafana/loki:3.7.8` / `grafana/alloy:v1.20.0`  | 3100 / 12345                 | logs                | container logs → Loki (Grafana → Explore)          |
| `kafka-ui`              | `kafbat/kafka-ui:v1.5.0`                        | 8080                         | tools               | topics, consumer groups, lag                       |
| `k6`                    | `grafana/k6:2.3.0`                              | 5665 (live dashboard)        | loadtest            | load test, HTML report in `docker/k6/reports/`     |

Every host port binds **127.0.0.1 only** and can be moved with a `*_HOST_PORT` variable (list at the bottom of
[`.env.example`](../.env.example)), e.g. `POSTGRES_HOST_PORT=15432 docker compose up -d` when 5432 is taken.
Inside the `backend` network containers use service names (`postgres:5432`, `kafka:9092`, `identity-service:50051`…);
every app container listens on HTTP **3000** (API or health + metrics) and gRPC **50051**.

## Topologies & profiles

- **No profile**: infrastructure only. The init jobs (`kafka-init`, `cassandra-init`, `storage-init`) run once per
  `up`, idempotently, and exit 0.
- **`monolith`** or **`microservices`**: never both. Each topology's edge app carries the network alias **`api`** and
  publishes host port 3000, so k6, docs and your browser don't care which one runs.
- **`observability`**, **`logs`**, **`tools`**, **`loadtest`** stack on top of either.
- `COMPOSE_PROFILES=microservices,observability` (in the shell or the root `.env`) replaces the `--profile` flags.

## Dev loops

1. **Apps on the host, infra in Docker (fastest).** `docker compose up -d --wait`, then `bun run dev` (monolith) or
   `bun run dev:microservices`. The `@app/config` defaults target the published ports, so no `.env` is needed
   (Kafka: `localhost:9094`, the EXTERNAL listener). `bun run setup:env` creates `.env` files if you want to tweak.
2. **Apps in Docker.** `docker compose --profile microservices watch` rebuilds and recreates an app when its folder,
   `libs/`, `package.json` or `bun.lock` changes. Dependency layers stay cached, so a source change costs ~30 s.
   `APP_TARGET=dev` swaps in the `dev` target (TS sources, no compile step, see below).
3. **Hybrid.** Services in Docker, one app on the host: the services publish their gRPC ports on the host-dev
   defaults (50051/50052/50053), so `bun run dev:gateway` reaches them with zero config.

Root `.env` vs. containers: Compose reads the root `.env` **only for `${VAR}` interpolation**. Containers get their
environment from `docker-compose.yml` (plus an optional, gitignored **`.env.docker`**). Compose-only knobs are
therefore prefixed `DOCKER_` or suffixed `_HOST_PORT`, so host-dev values (e.g. `NODE_ENV=development`) can never
leak into containers. Deliberate pass-throughs: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CASSANDRA_KEYSPACE`,
the Postgres/RustFS credentials.

## Configuration of the app containers

Env names are exactly those of `@app/config` (all documented, with defaults, in [`.env.example`](../.env.example);
`node scripts/check-env-example.mjs` fails on drift). Notable compose choices:

| Setting                                    | Value                                   | Why                                                                              |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------- |
| `NODE_ENV`                                 | `production` (`DOCKER_NODE_ENV`)        | same code paths as prod (docs stay on via `DOCKER_DOCS_ENABLED=true`)            |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | `compose-local-…` (`DOCKER_JWT_*`)      | production mode rejects the dev-default secrets; these are NOT secret            |
| `OTEL_SDK_DISABLED`                        | `true` (`DOCKER_OTEL_SDK_DISABLED`)     | set `false` **and** start `observability` to send traces to `http://jaeger:4318` |
| `DATABASE_RUN_MIGRATIONS`                  | `true`                                  | advisory-locked; see [Migrations](#bootstrap-jobs--migrations)                   |
| `KAFKA_GROUP_ID`                           | `monolith`, `gateway-push`, `<service>` | explicit consumer groups                                                         |
| `S3_PUBLIC_ENDPOINT`                       | `http://localhost:${S3_HOST_PORT}`      | presigned URLs must be reachable from the host, not `rustfs:9000`                |
| `IDENTITY/NOTIFICATIONS/BILLING_GRPC_URL`  | `<service>:50051`                       | grpc-js resolves every A record of a scaled service (round robin)                |
| `CLUSTER_WORKERS`                          | `1`                                     | scale with replicas (`--scale`), not `node:cluster`, in containers               |
| `NODE_OPTIONS`                             | `--max-old-space-size=…`                | ≈ 70–75 % of the container memory limit                                          |

Tracing end to end:
`DOCKER_OTEL_SDK_DISABLED=false docker compose --profile monolith --profile observability up -d --wait`, then open
Jaeger (http://localhost:16686) or Grafana → Explore → Jaeger. Host apps: set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.

## Bootstrap jobs & migrations

- **Kafka topics** ([`docker/kafka/topics.txt`](../docker/kafka/topics.txt)) = `@app/contracts` `KAFKA_TOPIC_VALUES` +
  `DEAD_LETTER_TOPIC_VALUES` (3 topics × 6 partitions + 3 `.dlq` × 1). Broker auto-creation is **off**, as in
  production: a missing topic fails loudly at consumer start instead of being created by a typo.
  `node scripts/docker/check-kafka-topics.mjs` (after `bun run build`) fails when the file drifts from the contracts.
- **Cassandra**: `cassandra-init` creates `CREATE KEYSPACE IF NOT EXISTS <CASSANDRA_KEYSPACE>` with
  `NetworkTopologyStrategy {'datacenter1': 1}` and asserts the node's DC equals the apps' `CASSANDRA_LOCAL_DC`. Tables
  come from the services' own CQL migrations (`@app/cassandra`, LWT-locked) at boot.
- **Buckets**: `uploads` in RustFS (SigV4-signed `PUT` via curl) and in fake-gcs, verified with a HEAD/GET.
- **Postgres**: `docker/postgres/init/01-extensions.sql` (first start only) adds `pg_stat_statements` and `pg_trgm`.
  Tables come from the Drizzle migrations (`libs/database/src/migrations`), applied at boot under an advisory lock
  (`DATABASE_RUN_MIGRATIONS=true`). In production, run them as a release job with the same image:
  `docker compose run --rm --no-deps -w /app/libs/database identity-service dist/migrate.js` (Kubernetes: a Job
  with `workingDir: /app/libs/database`, `args: [dist/migrate.js]`) and set `DATABASE_RUN_MIGRATIONS=false`.
- **`infra-ready`**: `docker compose up --wait` only accepts a one-shot container that _exited_ when an enabled service
  depends on it with `service_completed_successfully`. Without an app profile nothing would, and `--wait` would fail
  with `kafka-init exited (0)`. This idle 1 MB container depends on the three init jobs, and so means "infra bootstrapped".

`scripts/docker/check-infra.sh` boots the infra in an isolated project (`bp-infra-check`), asserts all of the above
(topics + partitions + auto-create off, keyspace + DC, extensions + `uuidv7()`, password-less Redis from another
container + `noeviction`, both buckets, every host port), prints `docker compose stats` and removes the project.
CI runs it on every pipeline (push to master, pull requests).

## Images (Dockerfile)

One image per app, selected with `--build-arg APP=<folder under apps/>`:

```text
oven/bun ─┐ (binary only)
node:24-trixie-slim ── toolchain ── manifests (package.json × N, bun.lock, bunfig.toml, patches/)
                                      ├─ deps ──────── bun install --frozen-lockfile --ignore-scripts
                                      │   ├─ dev ───── COPY . . → `bun run dev` (node --watch + swc-node, TS sources)
                                      │   └─ build ─── COPY . . → bun run --filter './libs/*' --filter ./apps/$APP build (swc)
                                      └─ prod-deps ─── bun install --production --filter ./apps/$APP (the app's closure only)
                                           └─ assemble ── scripts/docker/assemble-image.mjs (prune, copy dist, verify)
                                                ├─ runtime-alpine ── node:24-alpine + tini, user node
                                                └─ runtime (default) ── gcr.io/distroless/nodejs24-debian13:nonroot
```

```bash
docker build --build-arg APP=identity-service -t boilerplate/identity-service .                           # distroless
docker build --build-arg APP=identity-service --target runtime-alpine -t boilerplate/identity-service:debug .
docker build --build-arg APP=identity-service --build-arg VCS_REF=$(git rev-parse HEAD) -t … .           # OCI revision label
```

- **Bun installs, Node runs.** The toolchain is `node:24-trixie-slim` with the Bun binary copied in, so swc runs on
  real Node 24. The runtime has no Bun at all.
- **Hoisted linker.** `bunfig.toml` uses `linker = "hoisted"`: one copy of each package in the **root**
  `node_modules`, workspace packages symlinked as `node_modules/@app/<name>` (relative links, preserved by `COPY`).
  The image copies that root tree; there are no per-package `node_modules`.
- **Only the app's closure ships.** The filtered production install contains only the dependencies of the app and
  of its workspace libs. `assemble-image.mjs` then deletes every other `apps/*` / `libs/*` folder, copies the compiled
  `dist/` of the closure and **fails the build** when
  - a non-TS asset under a package's `src/` (`.proto`, `.hbs`, `.cql`, `.sql`, drizzle `meta/*.json`) is missing
    from its `dist/` (swc `copyFiles`),
  - a declared runtime dependency of any closure package is not installed, or a workspace symlink dangles,
  - `dist/main.js` or `dist/instrument.js` is missing.
- **Pruned `node_modules`** (`PRUNE_NODE_MODULES=true`, default): `*.d.ts`, `*.map`, TS sources (Node refuses to
  strip types under `node_modules`), Markdown (license/notice files kept) and the `typescript` package (an optional
  peer of `@nestjs/graphql`/`@nestjs/swagger`, used only by their CLI plugins). It is removed only if no installed
  package hard-depends on it. This takes the monolith from 465 MB to 294 MB. Build with
  `--build-arg PRUNE_NODE_MODULES=false` to keep them (e.g. for `--enable-source-maps` debugging).
- **Runtime**: `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, non-root (65532 distroless / `node` alpine),
  `WORKDIR /app/apps/$APP`, `CMD ["--import", "./dist/instrument.js", "dist/main.js"]` (OpenTelemetry hooks load
  before any instrumented module). `HEALTHCHECK` = Node `fetch` of `/health/live` (no shell in distroless;
  `--start-interval=2s` makes containers healthy within seconds). Kubernetes ignores it: use `httpGet` probes on
  `/health/live` (liveness) and `/health/ready` (readiness).
- **`UV_THREADPOOL_SIZE`** (build arg / env, default 4): the libuv pool runs Argon2id, zlib, fs and `dns.lookup`.
  **Keep it ≤ the CPUs available to the container.** Measured with the monolith capped at 2 CPUs under k6
  (5 sign-ups/s + 20 reads/s): 4 threads gave p95 **36 ms** (cached read p95 9.6 ms, 0 dropped iterations); 16 threads
  gave p95 **304 ms … 7.2 s** with dropped iterations. Busy threads beyond the CFS quota get the whole cgroup throttled,
  event loop included. Raise it together with the CPU limit.
- No `--enable-source-maps` by default: it makes every `Error.stack` access pay a source-map lookup.
- **`dev` target**: the full dev `node_modules` + sources, runs `bun run dev` from TS (no build step). It is large
  (the entire toolchain) and slow to export on Docker Desktop; prefer dev loop 1 unless you need Linux-only behaviour.

Measured (Apple silicon, Docker Desktop 4 CPU / 4 GB, other containers running):

| Image                   | Size (distroless, pruned) | Workspace packages | Assets verified | Runtime deps checked |
| ----------------------- | ------------------------- | ------------------ | --------------- | -------------------- |
| `monolith`              | 294 MB                    | 19                 | 14              | 384                  |
| `gateway`               | 294 MB                    | 19                 | 14              | —                    |
| `notifications-service` | 280 MB                    | 13                 | —               | —                    |
| `billing-service`       | 245 MB                    | 14                 | —               | —                    |
| `identity-service`      | 242 MB (alpine: 247 MB)   | 12                 | 6               | 231                  |

Build time: ~5.5 min cold (the full and the filtered install share a locked cache, so they serialize), **~30 s** for
a source-only change (dependency layers cached), ~40 s for another app once the full install is cached.
The gateway ships as much as the monolith because the domain-lib barrels import their infrastructure
(`@app/notifications` → cassandra/mailer…); `@app/<x>/api` subpath exports would slim it.

## Observability

- **Prometheus** ([`docker/prometheus/prometheus.yml`](../docker/prometheus/prometheus.yml)) discovers apps with DNS
  SD on the compose service names (port 3000): one target per replica, nothing for profiles that aren't running.
  It sets the `service` label itself. Job `host-apps` scrapes apps started on the host (`host.docker.internal:3000-3003`,
  `service="host:<port>"`). When the API runs in compose, `host:3000` is that same container through its published port.
  The remote-write receiver is on for k6.
- **Grafana** (http://localhost:3300, **3300** because 3000–3003 are the API/services host-dev ports): provisioned
  datasources (Prometheus, Jaeger, Loki, fixed UIDs) and the home dashboard **NestJS services overview**
  ([`docker/grafana/dashboards/nestjs-overview.json`](../docker/grafana/dashboards/nestjs-overview.json)):
  throughput, p50/p95/p99 latency and 4xx/5xx ratio per service from
  `http_request_duration_seconds{method,route,status_code}`, top routes by rate and by p95, status-code mix, event-loop
  lag p99, CPU, RSS/heap, GC time, libuv handles, and a k6 row. `GF_PLUGINS_PREINSTALL_DISABLED=true` is required:
  Grafana 13 otherwise "updates" its bundled Prometheus plugin from grafana.com at startup, and the datasource stays
  broken until (or, offline, forever after) the download ends.
- **Jaeger 2.20.0**, pinned: 2.21 removed the `/api/services` + `/api/traces` endpoints that Grafana 13's Jaeger
  datasource still calls. It is also an OTLP collector (4317 gRPC / 4318 HTTP), so no separate collector is needed.
- **Loki + Alloy** (`logs`): Alloy tails this project's containers through the Docker socket, lifts pino's `level` to
  a label and keeps `trace_id`/`span_id` as structured metadata (log → trace links). Alloy needs
  `/var/run/docker.sock` (check permissions on rootless Docker).

## Load testing (k6)

[`docker/k6/script.js`](../docker/k6/script.js), open model (`constant-arrival-rate`, no coordinated omission):

- **`journey`** (`RATE`/s): `POST /v1/auth/register` (unique email) → `POST /v1/auth/login` → `GET /v1/auth/me` →
  `GET /v1/users/:id` (cache hit) → `POST /graphql { me }`. Each iteration sends its own `X-Forwarded-For`, so the
  per-IP auth throttle models many clients (`TRUST_PROXY=true`).
- **`browse`** (`READ_RATE`/s, off by default): the three authenticated reads by a pool of users registered in
  `setup()`, sized to stay under the per-user `THROTTLE_LIMIT`.
- **Thresholds**: error rate < `MAX_ERROR_RATE` (1 %), p95 < `P95_MS` (250 ms), cached-read p95 < `P95_MS/2`, checks
  > 99 %, dropped iterations ≤ `MAX_DROPPED_RATIO` (1 %) of the planned ones. `setup()` traffic is excluded.

```bash
docker compose --profile microservices --profile observability up -d --build --wait
K6_RATE=5 K6_READ_RATE=20 K6_DURATION=2m docker compose --profile loadtest run --rm k6
K6_OUT= docker compose --profile loadtest run --rm k6        # without the observability profile (no remote write)
open docker/k6/reports/k6-report.html                        # HTML report of the last run; live: http://localhost:5665
```

Measured (same laptop, k6 in the same 4-CPU VM): monolith, `RATE=5 READ_RATE=20` for 40 s: **p95 36 ms**, cached
read p95 9.6 ms, 0 errors. Gateway + services, defaults (`RATE=5`, 1 min): **p95 91 ms**, cached read p95 12 ms,
0 errors. With `READ_RATE=20` added, the shared 4-core VM saturates (p95 ~0.8 s). Run k6 on another machine
(`K6_BASE_URL`) for serious numbers.

## Resource budget (4 GB)

Memory limits are caps (sum > 4 GB on purpose); measured RSS once idle:

| Container                                    | Limit                    | RSS                      | Notes                                                               |
| -------------------------------------------- | ------------------------ | ------------------------ | ------------------------------------------------------------------- |
| cassandra                                    | 1.5 GB                   | 1.05 GB                  | `MAX_HEAP_SIZE=512M` (`CASSANDRA_HEAP`), `MaxDirectMemorySize=256M` |
| kafka                                        | 768 MB                   | 300–420 MB               | `-Xmx384m`; CLI tools (healthcheck/init) run with a 96–128 MB heap  |
| postgres                                     | 512 MB                   | 40 MB                    | `shared_buffers=128MB`, `jit=off`, `pg_stat_statements`             |
| rustfs / redis / mailpit / gcs               | 256 / 256 / 128 / 128 MB | 55–90 / 15 / 17 / 12 MB  | Redis `maxmemory 192mb noeviction` (BullMQ)                         |
| monolith                                     | 768 MB                   | 230 MB                   | heap cap 512 MB                                                     |
| gateway · identity · notifications · billing | 512 · 448 · 448 · 448 MB | 180 · 130 · 160 · 120 MB | heap caps 384/320 MB                                                |

Infra ≈ 1.6 GB, + one topology ≈ 0.25 (monolith) / 0.6 GB (microservices), + observability ≈ 0.4 GB. Running
**everything at once** (both extra profiles + `logs` + `tools`) exceeds 4 GB and the VM starts reclaiming memory:
start what you need, or raise Docker Desktop's memory.

## CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))

- **verify**: Node 24 (`.nvmrc`) + Bun 1.4.2, `bun install --frozen-lockfile`, `bun run check` (Biome, ESLint,
  Prettier, tsc), `bun run test`, `bun run build`, then the drift checks (`.env.example`, Kafka topics).
- **image** (matrix of the 5 apps): `docker buildx` of the `runtime` target, not pushed, GitHub Actions cache per app.
- **compose**: `scripts/docker/validate-compose.sh` (`docker compose config` for every profile combination + one `api`
  per topology) and `scripts/docker/check-infra.sh` (boots and asserts the infra, then tears it down).

## Gotchas (all hit or verified while building this)

1. **PG18 volume path**: mount `/var/lib/postgresql` (PGDATA is `/var/lib/postgresql/18/docker`). The old
   `/var/lib/postgresql/data` silently lands in an anonymous volume.
2. `pg_isready` over the unix socket reports ready during initdb; the healthcheck uses `-h 127.0.0.1`.
3. `redis-cli ping` exits 0 on error replies: the healthcheck greps `PONG`. **BullMQ needs `noeviction`.**
4. Cassandra 5 = G1: set `MAX_HEAP_SIZE` only (`HEAP_NEWSIZE` is CMS-only). The DC name (`CASSANDRA_DC`) must equal
   the apps' `CASSANDRA_LOCAL_DC` or the driver ignores the node. cassandra-driver 4.10 speaks protocol v4.
5. Single-node Kafka needs RF=1 on **every** internal topic (else "group coordinator not available"). The CLI inherits
   `KAFKA_HEAP_OPTS` (shrink it for probes), and `apache/kafka-native` has no CLI. A few "coordinator is loading" errors
   from kafkajs on first start are normal. kafkajs is patched (`patches/kafkajs@2.2.4.patch`) for the Node 24
   1 ms idle-timer loop.
6. `docker compose up --wait` needs the `infra-ready` sentinel (above). `healthcheck.start_interval` requires
   `start_period` (a runtime error, not caught by `docker compose config`).
7. Mailpit: never set `MP_ENABLE_PROMETHEUS=0` (parsed as a listen address → crash loop).
8. MinIO images are gone and LocalStack needs an auth token: hence RustFS. Presigned URLs embed the signing host:
   `S3_PUBLIC_ENDPOINT` must be reachable by the client.
9. fake-gcs: always pass `GCS_API_ENDPOINT` (a bare `STORAGE_EMULATOR_HOST` without `/storage/v1` breaks the SDK).
10. Jaeger ≥ 2.21 breaks Grafana's Jaeger datasource; Grafana 13 needs `GF_PLUGINS_PREINSTALL_DISABLED=true`;
    literal `$` in Grafana provisioning files is `$$`.
11. `UV_THREADPOOL_SIZE` above the container's CPU quota throttles the event loop (measured above).
12. zsh users: `docker build -t img/$app:local` expands `$app:l` (lowercase modifier) → quote as `"img/${app}:local"`.
13. k6 threshold selectors cannot contain `:` or `,` in tag values (hence the `GET /v1/users/<id>` tag).
14. Distroless has no shell: debug with `--target runtime-alpine`, `docker compose logs`, or
    `docker run --rm --network <project>_backend redis:8.10.2-alpine3.23 wget -qO- http://gateway:3000/metrics`.

## What is local-only (don't ship this compose file)

No Redis password or TLS, default RustFS/Grafana/Postgres credentials, known JWT secrets, Kafka PLAINTEXT with RF=1,
Cassandra RF=1, in-memory Jaeger, anonymous Grafana viewer and migrations at boot. Production: managed/secured
services, secrets from a secret store, `DATABASE_RUN_MIGRATIONS=false` plus a migration job, and replicas
behind a load balancer whose idle timeout is below `HTTP_KEEP_ALIVE_TIMEOUT_MS` (72 s).
