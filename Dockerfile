# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────────────────────
# One image per app of the Bun-workspace NestJS 12 (ESM) monorepo. APP = folder name under apps/.
#
#   docker build --build-arg APP=gateway -t boilerplate/gateway .                          # prod, distroless
#   docker build --build-arg APP=gateway --target runtime-alpine -t boilerplate/gateway .  # prod + shell
#   docker build --build-arg APP=gateway --target dev -t boilerplate/gateway:dev .         # TS sources
#
# Bun is ONLY the package manager (install + script runner); Node.js 24 LTS runs everything,
# including the build tools. Runtime deps are declared per app/lib package.json (never the root),
# so a filtered production install yields exactly the app's closure. bunfig.toml uses the HOISTED
# linker: one copy of every package in the ROOT node_modules, workspace packages symlinked under
# node_modules/@app/* (no per-package node_modules). See docs/DOCKER.md.
# ─────────────────────────────────────────────────────────────────────────────────────────────
ARG NODE_VERSION=24.21.0
ARG BUN_VERSION=1.4.2
ARG ALPINE_VERSION=3.24
ARG DISTROLESS_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot

# ---- bun binary donor ----------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS bun

# ---- toolchain: Node 24 (glibc = Node's tier-1 platform) + the Bun binary ---------------------
# Not oven/bun: swc/nx/lerna must run on real Node 24, not on Bun's `node` shim.
FROM node:${NODE_VERSION}-trixie-slim AS toolchain
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV BUN_INSTALL_CACHE_DIR=/var/cache/bun \
    CI=true \
    HUSKY=0 \
    NX_DAEMON=false \
    NX_NO_CLOUD=true
WORKDIR /repo

# ---- manifests only: the install layers stay cached until a package.json / bun.lock changes ---
FROM toolchain AS manifests
COPY --parents package.json bun.lock bunfig.toml apps/*/package.json libs/*/package.json ./
# `patchedDependencies` (kafkajs idle-timer fix) must be present before install, or bun aborts.
COPY patches ./patches

# ---- every dependency (incl. dev) for compiling ------------------------------------------------
# --ignore-scripts: the root `prepare: husky` would run on a full install.
# --backend=copyfile: the cache is a separate mount, so hardlinks into it are impossible.
FROM manifests AS deps
RUN --mount=type=cache,id=bun-install-cache,target=/var/cache/bun,sharing=locked \
    bun install --frozen-lockfile --ignore-scripts --backend=copyfile

# ---- dev: runs straight from TS sources (node --watch + @swc-node, `@app/source` condition) ----
# No build step at all, so a compose `watch` rebuild of this target only re-copies sources.
FROM deps AS dev
ARG APP
ARG UV_THREADPOOL_SIZE=4
RUN test -n "${APP}" || { echo "error: --build-arg APP=<folder under apps/> is required" >&2; exit 1; }
ENV NODE_ENV=development \
    APP=${APP} \
    UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE}
COPY . .
WORKDIR /repo/apps/${APP}
EXPOSE 3000 50051 9229
CMD ["bun", "run", "dev"]

# ---- build all libs + the selected app (swc, dependency order) ---------------------------------
# swc `copyFiles` puts the non-TS assets (.proto, .hbs, .cql, .sql + drizzle meta) next to the JS.
FROM deps AS build
ARG APP
RUN test -n "${APP}" || { echo "error: --build-arg APP=<folder under apps/> is required" >&2; exit 1; }
COPY . .
RUN bun run --filter "./libs/*" --filter "./apps/${APP}" build

# ---- production node_modules for ONLY this app's dependency closure ----------------------------
FROM manifests AS prod-deps
ARG APP
RUN --mount=type=cache,id=bun-install-cache,target=/var/cache/bun,sharing=locked \
    bun install --frozen-lockfile --production --ignore-scripts --backend=copyfile \
      --filter "./apps/${APP}"

# ---- assemble /out = manifests + prod node_modules + compiled dist of the closure --------------
# assemble-image.mjs prunes apps/libs outside the closure, copies their dist/ and FAILS the build
# on a missing asset (src/**/*.{proto,hbs,cql,sql,json} not in dist/), a missing runtime dependency,
# a dangling workspace symlink or a missing dist/main.js / dist/instrument.js. PRUNE_NODE_MODULES
# also drops *.d.ts, *.map, TS sources, docs and the `typescript` package from node_modules
# (never read at runtime; ~35-40 % of the image: monolith 465 -> 294 MB). Build with
# --build-arg PRUNE_NODE_MODULES=false to keep them.
FROM toolchain AS assemble
ARG APP
ARG PRUNE_NODE_MODULES=true
COPY --from=prod-deps /repo /out
COPY scripts/docker/assemble-image.mjs /usr/local/lib/assemble-image.mjs
RUN --mount=type=bind,from=build,source=/repo,target=/build \
    node /usr/local/lib/assemble-image.mjs --app "${APP}" --build /build --out /out \
      --prune "${PRUNE_NODE_MODULES}"

# Runtime notes (both runtime stages):
# - UV_THREADPOOL_SIZE (libuv pool: Argon2id hashing, zlib, fs, dns.lookup) defaults to 4. Keep it
#   <= the container's CPU quota: measured with the monolith capped at 2 CPUs under k6, 16 threads
#   of Argon2id exhausted the CFS quota and the kernel throttled the whole cgroup, event loop
#   included (p95 36 ms with 4 threads vs 0.3–7 s with 16). Raise it only with more CPUs.
# - No --enable-source-maps: it makes every Error.stack access pay a source-map lookup.
# - Size the heap per container (NODE_OPTIONS=--max-old-space-size ~ 75% of the memory limit).

# ---- runtime-alpine (optional): musl + busybox shell + tini, for debugging ---------------------
# Bun installs both the -gnu and the -musl prebuilt natives (e.g. @node-rs/argon2) on linux,
# so the same production tree runs on both runtimes.
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS runtime-alpine
ARG APP
ARG UV_THREADPOOL_SIZE=4
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="${APP}" \
      org.opencontainers.image.source="https://github.com/alonecandies/nestjs-boilerplate" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"
RUN apk add --no-cache 'tini~0.19'
# TINI_SUBREAPER: stays correct (and quiet) when an outer init is PID 1 (compose `init: true`).
ENV NODE_ENV=production \
    APP=${APP} \
    HOST=0.0.0.0 \
    PORT=3000 \
    UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE} \
    TINI_SUBREAPER=1
COPY --from=assemble --link /out /app
WORKDIR /app/apps/${APP}
# node:1000 (numeric, so Kubernetes runAsNonRoot can verify it)
USER 1000:1000
EXPOSE 3000 50051
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--", "node"]
CMD ["--import", "./dist/instrument.js", "dist/main.js"]

# ---- runtime (default): distroless Node 24, glibc, non-root (65532), no shell ------------------
FROM ${DISTROLESS_IMAGE} AS runtime
ARG APP
ARG UV_THREADPOOL_SIZE=4
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="${APP}" \
      org.opencontainers.image.source="https://github.com/alonecandies/nestjs-boilerplate" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    APP=${APP} \
    HOST=0.0.0.0 \
    PORT=3000 \
    UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE}
COPY --from=assemble --link /out /app
# WORKDIR expands ARGs; exec-form CMD cannot, hence relative paths from the app folder.
WORKDIR /app/apps/${APP}
USER 65532:65532
EXPOSE 3000 50051
STOPSIGNAL SIGTERM
# No shell/curl in distroless: probe /health/live (no dependency checks) with Node's fetch.
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# distroless ENTRYPOINT is ["/nodejs/bin/node"]; instrument.js must load before any instrumented module.
CMD ["--import", "./dist/instrument.js", "dist/main.js"]
