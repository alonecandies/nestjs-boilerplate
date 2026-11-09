# Phase C Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

## Executive summary

Phase C (spec §11): 12 tasks for C-1..C-11 and AUDIT-F22. Wave 1 (C1-C7) starts now: lane `c-throttle` runs
C1→C5, lane `c-ws-errors` runs C6, then C7 (e2e + docs). Wave 2 (C8-C12, lane `c-tenant`) waits for B2-18/B2-22.
Merge wave 1 before B2-22 (it edits both `app.module.ts`, identity's credential decorators and both Api modules).

- C1 scope-keyed buckets `sha256(throttler, scope, tracker)`, one `user` budget (`THROTTLE_LIMIT` default now 300),
  `@RateLimit` policy registry, `SkipRateLimit`, boot check. C2 `identity.credentials`: sha256(email)+IP shared by
  REST and GraphQL, per-account failure lockout reset by `LockoutResetInterceptor`. C3 pre-auth `ip` guard before
  `AuthModule`, proxy-aware WS IPs (`@fastify/proxy-addr` 5.1.1). C4 IETF `RateLimit-Policy`/`RateLimit` (also on
  429, CORS-exposed), no `X-RateLimit-*`. C5 budgets fail open (250 ms timeout, `rate_limit_fail_open_total`),
  `auth`/`lockout` fail closed (503). C6 `@UseWsExceptionFilter` + allow-listed 4xx `details` (F22).
- Wave 2: C8 `tenant` budget, C9 GraphQL per-operation cost (429), C10 graphql-ws complexity + cost, C11 socket and
  handshake caps, C12 e2e + docs.

Review (2026-11-09) fixed in place; details in "Plan review" at the end:

- Rulings applied: `THROTTLE_LIMIT` default 300 (C1 code, spec, `.env.example`; C2-C5 assertions; C7 docs, k6);
  no aliases for `THROTTLE_AUTH_*`/`@AuthThrottle`/`AUTH_THROTTLE_KEY`/`DEFAULT_THROTTLER_NAME`, rename documented
  in `docs/CONFIGURATION.md`; targeted-lockout trade-off documented in `docs/SECURITY.md`.
- Lockout boundary made explicit and tested: threshold N admits attempts 1..N (a correct N-th password succeeds and
  resets); attempt N+1 after N failures is refused. New storage-level boundary test in C2.
- DI defects: `@Optional()` params typed `T | undefined` emit `Object` metadata, so the charger/caps were never
  injected (C9 plugin, C10 binder, C11 gateway): explicit `@Inject(Token)` added.
- C9 GraphQL de-duplication now remembers a refusal and repeats it for later root fields (no partial bypass).
- Non-existent helpers fixed: `makeStorage()`/`keys()` (C2, C5), `filter` and `ForbiddenDomainException` (C6),
  `connectionCtx`/`user` (C11); existing specs (`graphql-context.factory.spec.ts`, `notifications.gateway.spec.ts`)
  are appended to instead of recreated. C2 removes the stale `limits` assertion and unused `throttleConfig` import.
- C11 Socket.IO refusals built one way (`ProblemDetails` + `DEFAULT_PROBLEM_TYPE_BASE_URL`), exact insertion points.
- C3 gives the exact monolith `app.module.ts` comment rewrite; C3 spec uses `import type`.
- C7 docs list completed (`SkipThrottle` in SECURITY/ARCHITECTURE/billing README, PERFORMANCE `:525`, k6 script);
  the `rg` gate is split into a docs gate and a code gate (`SkipThrottle` legitimately stays in code).
- Cross-plan: G Tasks 2/3 (`./api` entries) handled in C1/C2 either order; E Task 7 libs vocabulary respected
  (no domain words in libs specs/comments); shared files table completed.
- G-10 hook clarified: count at the top of `recordDecision` and in `RateLimitCharger.charge`.

Unresolved (not blocking): `draft-ietf-httpapi-ratelimit-headers-11` field syntax was accepted by ruling, not
re-verified against the draft text; wave-2 field names (`tenantId`) must be revalidated when B2 merges.

**Goal:** Every documented rate limit in spec §11 exists, is configured from env, and is proven by tests. That
means per-IP, per-user, per-tenant and credential budgets with lockout, named policies, GraphQL per-operation cost,
standard headers, WebSocket error acks, connection caps and explicit Redis-down modes.

**Architecture:** Stay on `@nestjs/throttler` 6.7.1 and keep the `RedisThrottlerStorage` Lua bucket. Several
named throttlers (`ip`, `user`, `route`, `auth`, later `tenant`) are configured once in `AppThrottlerModule`.
Three guards share a base class `RateLimitGuardBase`, and each enforces only its own subset:

- `IpThrottlerGuard`: before `AuthModule`.
- `AppThrottlerGuard`: after it, for HTTP and GraphQL.
- `WsThrottlerGuard`: per Socket.IO message.

A bucket key is `sha256(throttler, scope, tracker)`:

- scope is the policy name, or `global`;
- tracker is `ip:<addr>`, `user:<id>`, `cred:<sha256(email)>|ip:<addr>` or `tenant:<id>`.

Domains declare named policies through `RateLimitModule.forFeature(...)`, with limits from their own config
namespace, and use them as `@RateLimit('<domain>.<name>')`.

**Tech Stack:** NestJS 11, Fastify 5, `@nestjs/throttler` 6.7.1, ioredis 6 (Lua via `defineCommand`), Apollo
Server 5, graphql-ws, Socket.IO, prom-client via `@willsoto/nestjs-prometheus`, zod 4 config, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md` §1 (rate-limit decision and
success criteria), §7 (principal), §11 (rate limiting), §12 (rate-limit metrics). Inventory:
`docs/superpowers/plans/program-work/inventory.md` (C-1 to C-11, AUDIT-F22). Conventions:
`docs/superpowers/plans/program-work/conventions.md`.

## Global Constraints

- **Node:** every command in this plan runs with this prefix. It is omitted below for brevity, but you must type
  it: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 24.4.0 >/dev/null;`. Run from the
  worktree root.
- **Search:** use `rg` and `fd`, and `jaq` for JSON. `grep`, `find` and `jq` are blocked by a hook.
- **Worktrees:**
  - Each lane has its own git worktree under the session scratchpad, off `feat/domains-tenancy`.
  - Lanes are merged `--no-ff -S` by the controller.
  - Only the controller runs `bun install`; a task that adds a dependency says so and stops for it.
- **Commits:**
  - One GPG-signed commit per task, with no attribution lines. The program decision of 2026-11-09 overrides the
    `Co-Authored-By` line in `conventions.md` §1.2 and §4.2.
  - Never `--no-verify`, never push.
  - Header: `<type>(<scope>[,<scope>]): <subject>`, at most 100 characters, subject starting lower-case, no
    trailing period.
  - Types: `build chore ci docs feat fix perf refactor revert style test`.
  - Scopes used here: `redis`, `config`, `common`, `auth`, `graphql`, `bootstrap`, `identity`, `notifications`,
    `billing`, `gateway`, `monolith`, `observability`, `deps`, `docs`, `repo`.
  - Check every header first: `printf '%s\n' "<header>" | bunx commitlint`.
- **Layering:**
  - `libs/` names no domain. Policy names such as `identity.credentials` live only in `domains/<x>`.
  - `@platform/redis` must not import `@platform/auth`; read users structurally, as `throttle-tracker.util.ts`
    does today.
  - `scripts/check-boundaries.mjs` runs inside `bun run check`.
- **Config:**
  - Platform keys go in `libs/config/src/namespaces/throttle.config.ts`.
  - Domain keys go in `domains/<x>/src/**/<name>.config.ts`, with literal `z.object` keys so that
    `scripts/check-env-example.mjs` sees them.
  - Every key appears in the root `.env.example` (commented default), in `docs/CONFIGURATION.md`, and in every
    app's `test/env-example.spec.ts` namespace list that loads it (gateway and monolith).
  - Run `node scripts/check-env-example.mjs`.
- **Tests:**
  - Unit: `npx vitest run --project <pkg> <path>`.
  - App e2e: `npx vitest run --project monolith:e2e` / `--project gateway:e2e` (sandbox off).
  - Static gate: `bun run check`.
  - Format before committing: `npx biome check --write <ts files>` and `npx prettier --write <md files>`.
- **Code style:**
  - Relative imports end in `.js`.
  - No `any`, no `console`. Use the Nest `Logger`.
  - `override` on subclass members; `T[]` arrays.
  - Every import is declared in that package's `package.json`.
- **Docs tables:** `docs/CONFIGURATION.md`, `docs/API.md`, `docs/SECURITY.md`, `docs/TESTING.md` and the
  `README.md` test count are edited only in C7 (wave 1) and C12 (wave 2), so that parallel lanes don't fight over
  Prettier-padded tables.

## Review Focus

These five failure modes would hurt users, and no unit test of the happy path catches them. Each has a named test
in its owning task:

1. **Renamed throttlers silently drop exemptions.** `@SkipThrottle()` defaults to `{ default: true }`
   (`throttler.decorator.js:27`). Once the throttler names change, the Stripe webhook
   (`billing.controller.ts:101`) and `@Throttle({ default })` (`notifications.gateway.ts:194`) would be throttled,
   or not throttled, by accident.
   Test: C1 `billing.controller.spec.ts` asserts `THROTTLER:SKIP<name>` for every name in `RATE_LIMIT_THROTTLERS`;
   the C7 e2e posts 50 webhooks from one IP and none is 429.
2. **The credential key is spoofable or splittable.** `Alice@X.com ` and `alice@x.com` must share one bucket. A
   missing or non-string email (`{ "email": ["a","b"] }`, GraphQL variables) must not crash the guard (500) or
   bypass the budget.
   Test: C2 `credential-tracker.util.spec.ts` (case, whitespace, NFKC, arrays, objects, missing field);
   C7 e2e mixes REST and GraphQL logins for one email and expects a shared 429.
3. **Lockout enables account enumeration or a permanent DoS.** A locked account must answer exactly like a plain
   rate limit (429 `RATE_LIMITED` plus `Retry-After`), for existing and non-existing emails alike, and must unlock
   after `IDENTITY_LOCKOUT_MS`. A successful login resets the counter.
   Test: C2 `app-throttler.guard.spec.ts` "lockout" cases; C7 e2e "unknown email locks identically".
4. **A spoofed `X-Forwarded-For` picks its own IP bucket.** With `TRUST_PROXY=false`, a WebSocket handshake or
   HTTP request carrying `X-Forwarded-For: 1.2.3.4` must still be keyed by the socket address. With a trusted
   CIDR, only the hop the proxy appended counts.
   Test: C3 `client-ip.util.spec.ts`; C7 e2e (HTTP).
5. **A Redis outage turns into a 5xx storm or an open door.** Budgets must fail open within
   `THROTTLE_REDIS_TIMEOUT_MS`, even when Redis hangs without disconnecting. `auth`/`lockout` must fail closed
   with 503, never 500.
   Test: C5 `redis-throttler.storage.spec.ts` (hung command, outage, per-throttler mode); C7 e2e
   `simulateOutage()`: login 503, while `POST /v1/auth/refresh` passes the open budgets and is answered by its
   handler (400/401, never the limiter's 503).

## Lane and files

**Lane `c-throttle` (wave 1, tasks C1 → C2 → C3 → C4 → C5, sequential: they all edit the guard chain). It owns:**

- `libs/redis/src/throttler/**`, `libs/redis/src/index.ts`, `libs/redis/package.json`
- `libs/config/src/namespaces/throttle.config.ts`, `libs/config/src/namespaces/namespaces.spec.ts` (throttle
  cases only)
- `domains/identity/src/presentation/rate-limit/**` (new)
- `domains/notifications/src/presentation/ws/notifications-rate-limit.ts` (new)
- `libs/bootstrap/src/integration.smoke.spec.ts` (rate-limiting block only)

**Lane `c-ws-errors` (wave 1, task C6, parallel with `c-throttle`). It owns:**

- `libs/common/src/errors/problem-details.ts` (+ spec), `libs/common/src/filters/ws-exception-filter.decorator.ts`
  (new), `libs/common/src/index.ts`
- `libs/graphql/src/errors/format-graphql-error.ts` (+ spec)

**C7 (wave 1, after both lanes merge) owns:**

- `apps/monolith/test/rate-limit.e2e-spec.ts`, `apps/gateway/test/rate-limit.e2e-spec.ts` (new)
- the docs listed in C7

**Lane `c-tenant` (wave 2, C8 → C9 → C10 → C11 → C12, after B2 merges) owns:**

- `libs/redis/src/throttler/**` again
- `libs/graphql/src/plugins/operation-rate-limit.plugin.ts` (new), `libs/graphql/src/apollo-config.factory.ts`
  (subscriptions block)
- `libs/redis/src/throttler/connection-caps.ts` (new)

**Shared files.** Exactly these changes; merge-sensitive:

| File                                                                                                                                                                                                   | Task                        | Change                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root `package.json`                                                                                                                                                                                    | C3                          | `catalog` gains `"@fastify/proxy-addr": "5.1.1"` (the controller runs `bun install`, which commits `bun.lock`)                                                                                                         |
| `libs/redis/package.json`                                                                                                                                                                              | C3                          | `dependencies` gains `"@fastify/proxy-addr": "catalog:"`                                                                                                                                                               |
| `apps/gateway/src/app.module.ts`                                                                                                                                                                       | C3                          | import `IpThrottlerModule` from `@platform/redis`; insert `IpThrottlerModule,` on the line before `AuthModule.forRootAsync(),` (`:51`); update the import-order comment `:36-38`                                       |
| `apps/monolith/src/app.module.ts`                                                                                                                                                                      | C3                          | same: `IpThrottlerModule,` before `AuthModule.forRootAsync(),` (`:76`); comment `:48-51`                                                                                                                               |
| `domains/identity/src/identity-api.module.ts`                                                                                                                                                          | C2                          | both `imports:` arrays (`forLocal` `:47`, `forRemote` `:65`) gain `IdentityRateLimitModule`                                                                                                                            |
| `domains/identity/src/presentation/http/auth.controller.ts`                                                                                                                                            | C2                          | `import { AuthThrottle } from '@platform/redis';` → `import { RateLimit } from '@platform/redis';` plus the policy import; two `@AuthThrottle()` lines (`:60`, `:81`) → `@RateLimit(IDENTITY_RATE_LIMITS.CREDENTIALS)` |
| `domains/identity/src/presentation/graphql/auth.resolver.ts`                                                                                                                                           | C2                          | same swap at `:4`, `:24`, `:40`; doc comment `:16`                                                                                                                                                                     |
| `domains/identity/src/presentation/http/identity-http.spec.ts`                                                                                                                                         | C2                          | `:4` import and the test at `:76-80`                                                                                                                                                                                   |
| `domains/identity/src/index.ts`                                                                                                                                                                        | C2                          | export `identityRateLimitConfig`                                                                                                                                                                                       |
| `domains/notifications/src/notifications-api.module.ts`                                                                                                                                                | C1                          | both `imports:` arrays gain `NotificationsRateLimitModule`                                                                                                                                                             |
| `domains/notifications/src/presentation/ws/notifications.gateway.ts`                                                                                                                                   | C1                          | `@Throttle({ default: … })` (`:194`) → `@RateLimit(NOTIFICATIONS_RATE_LIMITS.MARK_READ)`; import line `:24`                                                                                                            |
| `domains/notifications/src/presentation/ws/notifications.gateway.ts`                                                                                                                                   | C6                          | add `@UseWsExceptionFilter()` above `@UseGuards(WsSessionGuard, WsThrottlerGuard)` (`:83`)                                                                                                                             |
| `domains/notifications/src/index.ts`                                                                                                                                                                   | C1                          | export `notificationsRateLimitConfig`                                                                                                                                                                                  |
| `domains/billing/src/presentation/http/billing.controller.ts`                                                                                                                                          | C1                          | `@SkipThrottle()` (`:101`) → `@SkipRateLimit()`; import `:29`                                                                                                                                                          |
| `domains/billing/src/presentation/http/billing.controller.spec.ts`                                                                                                                                     | C1                          | test at `:234-237`                                                                                                                                                                                                     |
| `apps/{gateway,monolith}/test/env-example.spec.ts`                                                                                                                                                     | C1, C2                      | `NAMESPACES` gains `notificationsRateLimitConfig` (C1) and `identityRateLimitConfig` (C2)                                                                                                                              |
| root `.env.example`                                                                                                                                                                                    | C1, C2, C3, C5, C8, C9, C11 | lines in the `# ── throttle:` section (`:193-198`) and two new domain sections (C1 notifications, C2 identity)                                                                                                         |
| `libs/bootstrap/src/http/create-http-app.ts`                                                                                                                                                           | C4                          | `EXPOSED_HEADERS` (`:96-100`) gains `ratelimit-policy`, `ratelimit`                                                                                                                                                    |
| `libs/common/src/constants/headers.constants.ts`                                                                                                                                                       | C4                          | `HTTP_HEADERS` gains `RATE_LIMIT_POLICY: 'ratelimit-policy'`, `RATE_LIMIT: 'ratelimit'`                                                                                                                                |
| `libs/graphql/src/apollo-config.factory.ts`                                                                                                                                                            | C10                         | `subscriptions['graphql-ws']` gains `onSubscribe`                                                                                                                                                                      |
| `libs/graphql/src/auth/subscription-auth.ts`                                                                                                                                                           | C11                         | `onConnect` calls the connection caps                                                                                                                                                                                  |
| docs (`CONFIGURATION.md`, `API.md`, `SECURITY.md`, `TESTING.md`, `ARCHITECTURE.md`, `PERFORMANCE.md`, `README.md:63`), `domains/{identity,billing}/README.md`, `libs/{redis,config,graphql}/README.md` | C7, C12                     | see those tasks; `README.md:63` (test count) is also rewritten by the E, G, ledger and sharding plans: re-run `bun run test` and take the new count at merge time                                                      |
| `libs/config/src/namespaces/throttle.config.ts`, `libs/config/src/namespaces/namespaces.spec.ts`                                                                                                       | C1, C2, C3, C5, C8, C9, C11 | throttle defaults (one `toEqual` grows per task); `namespaces.spec.ts` is also edited by the ledger plan (L-2a, immudb) and E Task 7 (vocabulary): different tests, merge by hand if `merge-tree` reports a conflict   |
| `apps/{gateway,monolith}/test/support/e2e-env.ts`                                                                                                                                                      | C1, C2, C3                  | add `THROTTLE_LIMIT`, `IDENTITY_CREDENTIALS_LIMIT`, `IDENTITY_LOCKOUT_THRESHOLD`, `THROTTLE_IP_LIMIT` = `100000`                                                                                                       |
| `libs/bootstrap/src/integration.smoke.spec.ts`                                                                                                                                                         | C2                          | `@AuthThrottle` → `@RateLimit('smoke.credentials')` + `RateLimitModule.forFeature`; G Task 6 edits the `/metrics` assertions of the same file                                                                          |
| `libs/common/src/filters/all-exceptions.filter.spec.ts`                                                                                                                                                | C6                          | one new ws test; E Task 7 rewrites domain words in the existing ws tests (`notifications.markRead` → `alerts.markRead`)                                                                                                |
| `libs/graphql/src/graphql.module.ts`                                                                                                                                                                   | C9, C10, C11                | providers, top-level `imports`, `inject`/factory of `GraphQLModule.forRootAsync`                                                                                                                                       |
| `domains/{identity,notifications}/src/api/index.ts` (if G Tasks 2/3 merged first)                                                                                                                      | C1, C2                      | export the rate-limit config namespace there instead of `src/index.ts`                                                                                                                                                 |
| `docker/k6/script.js`                                                                                                                                                                                  | C7                          | comment and `THROTTLE_LIMIT` default 300                                                                                                                                                                               |

Cross-plan conflicts (checked against `2026-11-09-e-tests-ci-wave1.md`, `2026-11-09-g-metrics-packaging.md`,
`2026-11-09-ledger-wave0.md`, `2026-11-09-s-sharding-wave0.md`):

- G Tasks 2/3 (`./api` entry points, "must merge before B2") rewrite `domains/{identity,notifications}/src/index.ts`,
  both `*-api.module.ts` files, the gateway's `@domain/*` imports (`'@domain/x'` → `'@domain/x/api'`) and
  `apps/*/src/app.module.ts:1-4`. C1 and C2 are written to work in either order (see their steps). The C3 edits to
  `app.module.ts` touch the `@platform/redis` import list and the `AuthModule` lines, not G's lines.
- E Task 7 (libs vocabulary guard, `scripts/libs-vocabulary.spec.ts`) forbids domain words (`identity`, `billing`,
  `notifications`, `notification`, `payment(s)`, `stripe`, `checkout`, future domains) in `libs/**` spec, `test/` and
  `testing/` files. This plan's libs specs use `orders.*`, `files.*`, `chat.*`, `id.*`, `smoke.*`, `test.*` and
  `alerts.*` only; keep it that way.
- `.env.example`: C edits only the `# ── throttle:` section and adds two new sections after it; E, G, ledger and
  sharding add other sections.

Overlap with B2 (spec §5-§7): B2-18 changes `AuthUser`; B2-22 adds the CLS principal in `JwtAuthGuard`; B2's
switch-tenant and staff routes are added to identity presentation. Wave 1 does not touch `libs/auth/**`, the
identity application handlers, or `AuthUser`. It reads `req.user.id` structurally
(`throttle-tracker.util.ts:5-9`), so B2's richer `AuthUser` keeps working unchanged.

## Interface contracts (exported by `@platform/redis` after wave 1)

```ts
// libs/redis/src/throttler/throttle.constants.ts
export const THROTTLER = { IP: 'ip', USER: 'user', ROUTE: 'route', AUTH: 'auth', LOCKOUT: 'lockout' } as const;
export type ThrottlerName = (typeof THROTTLER)[keyof typeof THROTTLER];
export const RATE_LIMIT_THROTTLERS: readonly ThrottlerName[]; // ['ip','user','route','auth'] (+ 'tenant' in C8)
export const GLOBAL_SCOPE = 'global';
export const RATE_LIMIT_POLICY_KEY = 'app:rateLimitPolicy';
export const DEFAULT_THROTTLE_EXEMPT_PATHS: readonly string[]; // unchanged

// libs/redis/src/throttler/rate-limit-policy.ts
export type RateLimitKeyKind = 'ip' | 'user' | 'credentials';
export interface RateLimitLockout { readonly threshold: number; readonly durationMs: number; }
export interface RateLimitPolicy {
  readonly name: string;            // '<domain>.<name>', /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/
  readonly key: RateLimitKeyKind;
  readonly limit: number;           // >= 1
  readonly ttlMs: number;           // >= 1
  readonly blockMs?: number;        // default ttlMs
  readonly credentialField?: string; // key 'credentials' only; default 'email'
  readonly lockout?: RateLimitLockout; // key 'credentials' only
}
export class RateLimitPolicyRegistry {
  register(policies: readonly RateLimitPolicy[]): void;
  get(name: string): RateLimitPolicy | undefined;
  require(name: string): RateLimitPolicy; // throws Error('Unknown rate-limit policy "<name>"')
  names(): string[];
}
// libs/redis/src/throttler/rate-limit.decorator.ts
export const RateLimit: (policy: string) => CustomDecorator<string>;
export const SkipRateLimit: () => MethodDecorator & ClassDecorator;
// libs/redis/src/throttler/rate-limit.module.ts
export interface RateLimitFeatureOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  useFactory: (...deps: never[]) => readonly RateLimitPolicy[];
}
export class RateLimitModule { static forFeature(options: RateLimitFeatureOptions): DynamicModule; }
// libs/redis/src/throttler/rate-limit-key.util.ts
export function rateLimitKey(throttler: string, scope: string, tracker: string): string; // sha256 hex
// libs/redis/src/throttler/ip-throttler.guard.ts (C3)
export class IpThrottlerGuard; export class IpThrottlerModule; // import BEFORE AuthModule
// libs/redis/src/throttler/client-ip.util.ts (C3)
export type ClientIpResolver = (request: IncomingMessage | undefined) => string | undefined;
export function createClientIpResolver(trustProxy: boolean | string[]): ClientIpResolver;
// libs/redis/src/throttler/rate-limit-headers.ts (C4)
export interface RateLimitDecision { throttler: string; scope: string; limit: number; ttlMs: number;
  remaining: number; resetSeconds: number; blocked: boolean; retryAfterSeconds: number; }
export function formatRateLimitPolicy(decisions: readonly RateLimitDecision[]): string;
export function formatRateLimit(decisions: readonly RateLimitDecision[]): string;
// libs/redis/src/throttler/redis-throttler.storage.ts (C5)
export interface RedisThrottlerStorageOptions {
  failOpen?: boolean | ((throttlerName: string) => boolean); // default: name => !FAIL_CLOSED_THROTTLERS.has(name)
  commandTimeoutMs?: number;                                  // default 250
  onFailOpen?: (throttlerName: string) => void;               // metric hook
}
export const FAIL_CLOSED_THROTTLERS: ReadonlySet<string>; // {'auth','lockout'}
export const RATE_LIMIT_FAIL_OPEN_TOTAL = 'rate_limit_fail_open_total'; // Counter{throttler}
export const RATE_LIMIT_FAIL_OPEN_TOKEN = 'PROM_METRIC_RATE_LIMIT_FAIL_OPEN_TOTAL';
RedisThrottlerStorage.reset(key: string, throttlerName: string): Promise<void>; // C2
// C2
export function credentialHash(value: unknown): string; // sha256(NFKC/trim/lower) or 'none'
export class LockoutResetInterceptor; // APP_INTERCEPTOR from AppThrottlerModule
// Wave 2
RedisThrottlerStorage.incrementBy(key, ttl, limit, blockDuration, throttlerName, weight: number): Promise<ThrottlerStorageRecord>; // C9
export class RateLimitCharger { charge(bucket: RateLimitBucket, weight?: number): Promise<{ record; decision: RateLimitDecision }> } // C9
export class ConnectionCaps { admitHandshake(ip?): Promise<HandshakeVerdict>; acquireSocket(userId): Promise<boolean>; releaseSocket(userId): Promise<void> } // C11
export function authenticatedTenantId(user: unknown): string | undefined; // C8
// @platform/graphql: OperationRateLimitPlugin (C9), SubscriptionGuardRef / SubscriptionGuardBinder / createSubscriptionCheck (C10)
// @platform/common: UseWsExceptionFilter(), ProblemDetails.details, publicDetails() (C6)
// @platform/config ThrottleConfig after C11 (env default in brackets):
//   { ttlMs [THROTTLE_TTL_MS 60000], limit [THROTTLE_LIMIT 300], ipTtlMs [60000], ipLimit [THROTTLE_IP_LIMIT 600],
//     redisTimeoutMs [THROTTLE_REDIS_TIMEOUT_MS 250], tenantTtlMs [60000], tenantLimit [THROTTLE_TENANT_LIMIT 3000],
//     graphqlTtlMs [60000], graphqlCostLimit [THROTTLE_GRAPHQL_COST_LIMIT 20000], wsHandshakeLimit [30],
//     wsHandshakeTtlMs [60000], wsSocketsPerUser [10], wsSocketTtlMs [3600000] }
// @domain/identity: identityRateLimitConfig ('identityRateLimit': IDENTITY_CREDENTIALS_LIMIT 10,
//   IDENTITY_CREDENTIALS_TTL_MS 60000, IDENTITY_LOCKOUT_THRESHOLD 10, IDENTITY_LOCKOUT_MS 900000), exported from
//   ./api when G Task 2 has created it, else the root; IDENTITY_RATE_LIMITS.CREDENTIALS = 'identity.credentials' (internal)
// @domain/notifications: notificationsRateLimitConfig ('notificationsRateLimit': NOTIFICATIONS_MARK_READ_LIMIT 30,
//   NOTIFICATIONS_MARK_READ_TTL_MS 10000), same placement rule
// Removed, no aliases: AuthThrottle, AUTH_THROTTLE_KEY, DEFAULT_THROTTLER_NAME, THROTTLE_AUTH_TTL_MS, THROTTLE_AUTH_LIMIT
```

Redis key layout. The prefix comes from `RedisKeyService`; nothing else may write these keys:

- `…:throttle:{<throttler>:<sha256>}:hits|block` for every bucket;
- `…:wsconn:{<userId>}` for the socket counter (C11).

Config namespaces added: `identityRateLimit` (`@domain/identity`) and `notificationsRateLimit` (`@domain/notifications`).
The platform `throttle` namespace gains these keys:

- wave 1: `THROTTLE_IP_TTL_MS`, `THROTTLE_IP_LIMIT`, `THROTTLE_REDIS_TIMEOUT_MS`;
- wave 2: `THROTTLE_TENANT_*`, `THROTTLE_GRAPHQL_*`, `THROTTLE_WS_*`.

It loses `THROTTLE_AUTH_TTL_MS` and `THROTTLE_AUTH_LIMIT`.

For G-10 (rate-limit decision metrics): every guard decision (HTTP, GraphQL resolvers, Socket.IO messages, the
lockout) passes through C4's `RateLimitGuardBase.recordDecision(context, decision)`; G-10 increments
`rate_limit_decisions_total{throttler,scope,outcome}` as the FIRST statement there, before its early returns.
Wave 2 adds charges outside the guards (C9 GraphQL cost, C10 graphql-ws, C11 handshakes); they all go through
`RateLimitCharger.charge(bucket, weight)`, which returns the `RateLimitDecision`, so G-10 adds the same increment
there. Policy scopes are bounded by the registry, so `scope` is a safe label.

Wave-2 assumed B2 interface (revalidate when B2 merges; spec §5.3 and §7):

```ts
// @platform/auth (B2-18 / B2-22)
export type TenantRole = 'owner' | 'admin' | 'member';
export interface Principal {
  userId: string;
  tenantId: string | null;
  roles: TenantRole[];
  staff: boolean;
}
export interface AuthUser {
  id: string;
  tenantId: string;
  roles: TenantRole[];
  staff: boolean;
  jti: string;
  exp: number; /* … */
}
export function getPrincipal(): Principal | undefined; // reads CLS_PRINCIPAL from the active CLS context
```

Wave 2 reads only `req.user.tenantId` (HTTP/GraphQL), `socket.data.user.tenantId` (Socket.IO) and
`ctx.extra.user.tenantId` (graphql-ws), all structurally. It needs nothing beyond `tenantId: string` on the
authenticated user object, so it does not import `@platform/auth`. If B2 names the field differently (e.g. `tid`),
change only `authenticatedTenantId()` in C8.

What B2 must keep (contract from wave 1, so that the limits keep working after B2-18/B2-22 rewrite login):

- `req.user.id` (HTTP/GraphQL) and `socket.data.user.id` (Socket.IO) stay the user id; the throttlers read them
  structurally (`authenticatedUserId`).
- Every credential endpoint (REST and GraphQL `register`/`login`, and any new one such as password reset) carries
  `@RateLimit(IDENTITY_RATE_LIMITS.CREDENTIALS)` with the account identifier in body/input field `email`.
- A credential handler signals failure by THROWING. A handler that resolves (including a "pick a tenant" answer
  after a correct password) is a success, and `LockoutResetInterceptor` clears the account's lockout count.
- Global guard order in both `app.module.ts`: `IpThrottlerModule` → `AuthModule` (`JwtAuthGuard`, which B2-22
  extends with the CLS principal) → `AppThrottlerModule`.
- Switch-tenant and staff routes need no policy; they are charged to the global `ip`/`user` (and, in wave 2,
  `tenant`) budgets.

## Tasks

### Task C1: Scope-keyed buckets and the named policy registry (C-1, C-4)

**Wave:** 1. Start now from `feat/domains-tenancy`, in lane `c-throttle`.

**Why:**

- Buckets are keyed by @nestjs/throttler's `sha256(Class-handler-name-tracker)` (`throttler.guard.js:165-168`).
  So the 10/min credential window is per route: register, login and the GraphQL `login` each get their own (F17).
- The global `default` budget is also per route.
- There is no way for a domain to declare a named limit.

This task:

- keys every bucket as `sha256(JSON.stringify([throttler, scope, tracker]))`;
- renames `default` to `user` (one budget across all routes);
- adds a `route` throttler driven by named policies (`@RateLimit('<domain>.<name>')`), registered by domains with
  `RateLimitModule.forFeature`;
- checks at boot that every `@RateLimit` name is registered.

`@AuthThrottle()` keeps working until C2, now through one shared `auth` scope.

**Files:**

- Modify: `libs/redis/src/throttler/throttle.constants.ts` (whole file below)
- Create: `libs/redis/src/throttler/rate-limit-key.util.ts`, `libs/redis/src/throttler/rate-limit-key.util.spec.ts`
- Create: `libs/redis/src/throttler/rate-limit-policy.ts`, `libs/redis/src/throttler/rate-limit-policy.spec.ts`
- Create: `libs/redis/src/throttler/rate-limit.decorator.ts`, `libs/redis/src/throttler/rate-limit.module.ts`,
  `libs/redis/src/throttler/rate-limit-policy.validator.ts`
- Create: `libs/redis/src/throttler/rate-limit-guard.base.ts`
- Modify (replace content): `libs/redis/src/throttler/app-throttler.guard.ts`,
  `libs/redis/src/throttler/ws-throttler.guard.ts`, `libs/redis/src/throttler/app-throttler.module.ts`
- Modify (replace content): `libs/redis/src/throttler/app-throttler.guard.spec.ts`,
  `libs/redis/src/throttler/ws-throttler.guard.spec.ts`; Modify: `libs/redis/src/throttler/app-throttler.module.spec.ts`
- Modify: `libs/redis/src/index.ts`
- Create: `domains/notifications/src/presentation/ws/notifications-rate-limit.config.ts`,
  `domains/notifications/src/presentation/ws/notifications-rate-limit.ts`,
  `domains/notifications/src/presentation/ws/notifications-rate-limit.spec.ts`
- Modify: `domains/notifications/src/presentation/ws/notifications.gateway.ts` (`:24`, `:194`),
  `domains/notifications/src/notifications-api.module.ts`, `domains/notifications/src/index.ts`
- Modify: `domains/billing/src/presentation/http/billing.controller.ts` (`:29`, `:101`),
  `domains/billing/src/presentation/http/billing.controller.spec.ts` (`:234-237`)
- Modify: `apps/gateway/test/env-example.spec.ts`, `apps/monolith/test/env-example.spec.ts`, root `.env.example`
- Modify: `libs/config/src/namespaces/throttle.config.ts` (`THROTTLE_LIMIT` default 100 → 300, controller ruling of
  2026-11-09: one budget across all routes replaces the per-route buckets, so the old 100 would cut the effective
  limit sharply), `libs/config/src/namespaces/namespaces.spec.ts`
- Modify: `apps/gateway/test/support/e2e-env.ts`, `apps/monolith/test/support/e2e-env.ts` (Step 5)

**Interfaces:**

- Consumes: `ThrottlerGuard`, `ThrottlerRequest`, `normalizeIp`, `SkipThrottle` from `@nestjs/throttler` 6.7.1;
  `ThrottleConfig` (`ttlMs`, `limit`, `authTtlMs`, `authLimit`) from `@platform/config`; `authenticatedUserId(user:
unknown): string | undefined` (`throttle-tracker.util.ts:5`).
- Produces (exact):

  ```ts
  export const THROTTLER: {
    readonly IP: 'ip';
    readonly USER: 'user';
    readonly ROUTE: 'route';
    readonly AUTH: 'auth';
    readonly LOCKOUT: 'lockout';
  };
  export type ThrottlerName = 'ip' | 'user' | 'route' | 'auth' | 'lockout';
  export const RATE_LIMIT_THROTTLERS: readonly ThrottlerName[];
  export const GLOBAL_SCOPE: 'global';
  export const RATE_LIMIT_POLICY_KEY: 'app:rateLimitPolicy';
  export function rateLimitKey(throttler: string, scope: string, tracker: string): string;
  export type RateLimitKeyKind = 'ip' | 'user' | 'credentials';
  export interface RateLimitLockout {
    readonly threshold: number;
    readonly durationMs: number;
  }
  export interface RateLimitPolicy {
    readonly name: string;
    readonly key: RateLimitKeyKind;
    readonly limit: number;
    readonly ttlMs: number;
    readonly blockMs?: number;
    readonly credentialField?: string;
    readonly lockout?: RateLimitLockout;
  }
  export class RateLimitPolicyRegistry {
    register(p: readonly RateLimitPolicy[]): void;
    get(n: string): RateLimitPolicy | undefined;
    require(n: string): RateLimitPolicy;
    names(): string[];
  }
  export const RateLimit: (policy: string) => CustomDecorator<string>;
  export const SkipRateLimit: () => MethodDecorator & ClassDecorator;
  export class RateLimitModule {
    static forFeature(o: RateLimitFeatureOptions): DynamicModule;
  }
  export interface RateLimitSubject {
    readonly user?: unknown;
    readonly ip?: string | undefined;
  }
  export interface RateLimitBucket {
    throttler: string;
    scope: string;
    tracker: string;
    limit: number;
    ttlMs: number;
    blockMs: number;
  }
  export abstract class RateLimitGuardBase extends ThrottlerGuard {
    /* see code */
  }
  export const NOTIFICATIONS_RATE_LIMITS: { readonly MARK_READ: 'notifications.mark-read' }; // @domain/notifications (internal)
  export const notificationsRateLimitConfig; // namespace 'notificationsRateLimit'
  ```

- [ ] **Step 1: Write the failing unit tests.**

`libs/redis/src/throttler/rate-limit-key.util.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rateLimitKey } from './rate-limit-key.util.js';

describe('rateLimitKey', () => {
  it('is a stable sha256 hex digest of throttler, scope and tracker', () => {
    const key = rateLimitKey('user', 'global', 'user:u-1');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(rateLimitKey('user', 'global', 'user:u-1')).toBe(key);
  });

  it('changes with every component and cannot be forged by moving separators', () => {
    const base = rateLimitKey('route', 'a.b', 'ip:1.2.3.4');
    expect(rateLimitKey('user', 'a.b', 'ip:1.2.3.4')).not.toBe(base);
    expect(rateLimitKey('route', 'a.c', 'ip:1.2.3.4')).not.toBe(base);
    expect(rateLimitKey('route', 'a.b', 'ip:1.2.3.5')).not.toBe(base);
    expect(rateLimitKey('a', 'b\u0000c', 'd')).not.toBe(rateLimitKey('a', 'b', 'c\u0000d'));
    expect(rateLimitKey('a', 'b","c', 'd')).not.toBe(rateLimitKey('a', 'b', 'c","d'));
  });
});
```

`libs/redis/src/throttler/rate-limit-policy.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { type RateLimitPolicy, RateLimitPolicyRegistry } from './rate-limit-policy.js';

const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  name: 'files.upload',
  key: 'user',
  limit: 5,
  ttlMs: 60_000,
  ...overrides,
});

describe('RateLimitPolicyRegistry', () => {
  it('registers, resolves and lists policies', () => {
    const registry = new RateLimitPolicyRegistry();
    registry.register([policy(), policy({ name: 'orders.credentials', key: 'credentials' })]);
    expect(registry.get('files.upload')).toMatchObject({ limit: 5, ttlMs: 60_000 });
    expect(registry.require('orders.credentials').key).toBe('credentials');
    expect(registry.names()).toEqual(['files.upload', 'orders.credentials']);
    expect(registry.get('nope.nope')).toBeUndefined();
    expect(() => registry.require('nope.nope')).toThrow('Unknown rate-limit policy "nope.nope"');
  });

  it('freezes registered policies', () => {
    const registry = new RateLimitPolicyRegistry();
    registry.register([policy()]);
    expect(Object.isFrozen(registry.require('files.upload'))).toBe(true);
  });

  it('rejects a duplicate name', () => {
    const registry = new RateLimitPolicyRegistry();
    registry.register([policy()]);
    expect(() => registry.register([policy()])).toThrow('registered twice');
  });

  it.each([
    [{ name: 'upload' }, 'name must look like'],
    [{ name: 'Files.Upload' }, 'name must look like'],
    [{ limit: 0 }, 'limit must be an integer >= 1'],
    [{ limit: 1.5 }, 'limit must be an integer >= 1'],
    [{ ttlMs: 0 }, 'ttlMs must be an integer >= 1'],
    [{ blockMs: -1 }, 'blockMs must be an integer >= 0'],
    [{ lockout: { threshold: 3, durationMs: 1_000 } }, 'need key "credentials"'],
    [{ credentialField: 'email' }, 'need key "credentials"'],
    [{ key: 'credentials', lockout: { threshold: 0, durationMs: 1_000 } }, 'lockout threshold'],
  ] as const)('rejects %j', (overrides, message) => {
    const registry = new RateLimitPolicyRegistry();
    expect(() => registry.register([policy(overrides as Partial<RateLimitPolicy>)])).toThrow(
      message,
    );
  });
});
```

Replace `libs/redis/src/throttler/app-throttler.guard.spec.ts` with:

```ts
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  SkipThrottle,
  ThrottlerException,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { throttleConfig } from '@platform/config';
import { describe, expect, it, vi } from 'vitest';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { AuthThrottle } from './auth-throttle.decorator.js';
import { RateLimit, SkipRateLimit } from './rate-limit.decorator.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';
import {
  DEFAULT_THROTTLE_EXEMPT_PATHS,
  RATE_LIMIT_THROTTLERS,
  THROTTLER,
} from './throttle.constants.js';
import { createThrottleSkipIf, isThrottleExemptPath } from './throttle-exempt.util.js';

class Controller {
  list(): void {}
  other(): void {}
  @AuthThrottle() login(): void {}
  @AuthThrottle() register(): void {}
  @RateLimit('files.upload') upload(): void {}
  @RateLimit('files.upload') uploadAgain(): void {}
  @RateLimit('files.search') search(): void {}
  @SkipRateLimit() webhook(): void {}
}

type Transport = 'http' | 'graphql' | 'ws' | 'rpc';

function context(
  type: Transport,
  req: Record<string, unknown>,
  handler: () => void = Controller.prototype.list,
  res: Record<string, unknown> = { header: vi.fn() },
): ExecutionContext {
  const gqlArgs = [{}, {}, { req, reply: res }, {}];
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => Controller,
    getArgByIndex: (index: number) => gqlArgs[index],
    getArgs: () => gqlArgs,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

const record = (overrides: Partial<ThrottlerStorageRecord> = {}): ThrottlerStorageRecord => ({
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...overrides,
});

async function createGuard(options: Partial<Exclude<ThrottlerModuleOptions, unknown[]>> = {}) {
  const increment = vi.fn<ThrottlerStorage['increment']>(async () => record());
  const guard = new AppThrottlerGuard(
    {
      throttlers: [
        { name: THROTTLER.USER, ttl: 60_000, limit: 100 },
        { name: THROTTLER.ROUTE, ttl: 60_000, limit: 100 },
      ],
      ...options,
    },
    { increment },
    new Reflector(),
  );
  const registry = new RateLimitPolicyRegistry();
  registry.register([
    { name: 'files.upload', key: 'user', limit: 3, ttlMs: 10_000 },
    { name: 'files.search', key: 'ip', limit: 9, ttlMs: 5_000, blockMs: 0 },
  ]);
  Reflect.set(guard, 'policies', registry);
  Reflect.set(
    guard,
    'limits',
    throttleConfig.parse({ THROTTLE_AUTH_LIMIT: '7', THROTTLE_AUTH_TTL_MS: '30000' }),
  );
  await guard.onModuleInit();
  return { guard, increment };
}

const http = (handler: () => void, req: Record<string, unknown> = { headers: {}, ip: '1.2.3.4' }) =>
  context('http', req, handler);

describe('AppThrottlerGuard', () => {
  it('charges one user budget across every route (scope "global")', async () => {
    const { guard, increment } = await createGuard();
    const req = { headers: {}, user: { id: 'u-1' }, ip: '1.2.3.4' };
    await guard.canActivate(http(Controller.prototype.list, req));
    await guard.canActivate(http(Controller.prototype.other, req));
    const userCalls = increment.mock.calls.filter(([, , , , name]) => name === THROTTLER.USER);
    expect(userCalls).toHaveLength(2);
    expect(userCalls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'user:u-1'));
    expect(userCalls[1]?.[0]).toBe(userCalls[0]?.[0]);
  });

  it('falls back to the (normalised) client IP for anonymous requests', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.list, { headers: {}, ip: '2001:db8:abcd:12:1:2:3:4' }),
    );
    await guard.canActivate(http(Controller.prototype.list, { headers: {} }));
    expect(increment.mock.calls.map(([key]) => key)).toEqual([
      rateLimitKey('user', 'global', 'ip:2001:db8:abcd:12::/64'),
      rateLimitKey('user', 'global', 'ip:unknown'),
    ]);
  });

  it('charges a @RateLimit policy bucket shared by every route naming it, with the policy limits', async () => {
    const { guard, increment } = await createGuard();
    const req = { headers: {}, user: { id: 'u-1' }, ip: '1.2.3.4' };
    await guard.canActivate(http(Controller.prototype.upload, req));
    await guard.canActivate(http(Controller.prototype.uploadAgain, req));
    const routeCalls = increment.mock.calls.filter(([, , , , name]) => name === THROTTLER.ROUTE);
    expect(routeCalls).toEqual([
      [rateLimitKey('route', 'files.upload', 'user:u-1'), 10_000, 3, 10_000, 'route'],
      [rateLimitKey('route', 'files.upload', 'user:u-1'), 10_000, 3, 10_000, 'route'],
    ]);
  });

  it('keys an "ip" policy by IP even for authenticated users and honours blockMs', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.search, { headers: {}, user: { id: 'u-1' }, ip: '9.9.9.9' }),
    );
    expect(increment).toHaveBeenCalledWith(
      rateLimitKey('route', 'files.search', 'ip:9.9.9.9'),
      5_000,
      9,
      0,
      'route',
    );
  });

  it('does not charge the route throttler on routes without a policy', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(http(Controller.prototype.list));
    expect(increment.mock.calls.map(([, , , , name]) => name)).toEqual([THROTTLER.USER]);
  });

  it('shares one "auth" bucket across every @AuthThrottle route (F17)', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(http(Controller.prototype.login));
    await guard.canActivate(http(Controller.prototype.register));
    expect(increment.mock.calls).toEqual([
      [rateLimitKey('user', 'auth', 'ip:1.2.3.4'), 30_000, 7, 30_000, 'user'],
      [rateLimitKey('user', 'auth', 'ip:1.2.3.4'), 30_000, 7, 30_000, 'user'],
    ]);
  });

  it('@SkipRateLimit() skips every named throttler', async () => {
    const { guard, increment } = await createGuard();
    await expect(guard.canActivate(http(Controller.prototype.webhook))).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
    for (const name of RATE_LIMIT_THROTTLERS) {
      expect(Reflect.getMetadata(`THROTTLER:SKIP${name}`, Controller.prototype.webhook)).toBe(true);
    }
  });

  it('throttles graphql through the { req, reply } context and skips ws and rpc', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(context('graphql', { headers: {}, user: { id: 'u-2' } }));
    expect(increment.mock.calls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'user:u-2'));
    increment.mockClear();
    await expect(guard.canActivate(context('ws', {}))).resolves.toBe(true);
    await expect(guard.canActivate(context('rpc', {}))).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });

  it('rejects a blocked bucket with ThrottlerException and Retry-After', async () => {
    const { guard, increment } = await createGuard();
    increment.mockResolvedValue(record({ isBlocked: true, totalHits: 101, timeToBlockExpire: 42 }));
    const res = { header: vi.fn() };
    await expect(
      guard.canActivate(
        context('http', { headers: {}, ip: '1.2.3.4' }, Controller.prototype.list, res),
      ),
    ).rejects.toBeInstanceOf(ThrottlerException);
    expect(res.header).toHaveBeenCalledWith('Retry-After', 42);
  });

  it('honours ignoreUserAgents', async () => {
    const { guard, increment } = await createGuard({ ignoreUserAgents: [/kube-probe/i] });
    await guard.canActivate(
      http(Controller.prototype.list, {
        headers: { 'user-agent': 'kube-probe/1.30' },
        ip: '1.2.3.4',
      }),
    );
    expect(increment).not.toHaveBeenCalled();
  });

  it('a raw @SkipThrottle() only skips the throttler named default (use SkipRateLimit)', () => {
    class Legacy {
      @SkipThrottle() handler(): void {}
    }
    expect(Reflect.getMetadata('THROTTLER:SKIPuser', Legacy.prototype.handler)).toBeUndefined();
  });
});

describe('throttle exemptions', () => {
  it('matches ops paths on a / boundary only', () => {
    expect(isThrottleExemptPath('/health/ready', DEFAULT_THROTTLE_EXEMPT_PATHS)).toBe(true);
    expect(isThrottleExemptPath('/healthz', DEFAULT_THROTTLE_EXEMPT_PATHS)).toBe(false);
    const skipIf = createThrottleSkipIf(['/health']);
    const ctx = context('http', { url: '/health/live', headers: {} });
    expect(skipIf(ctx)).toBe(true);
  });
});
```

Replace `libs/redis/src/throttler/ws-throttler.guard.spec.ts` with:

```ts
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, type ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { RateLimit } from './rate-limit.decorator.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';
import { THROTTLER } from './throttle.constants.js';
import { WsThrottlerGuard } from './ws-throttler.guard.js';

class Gateway {
  onMessage(): void {}
  @RateLimit('chat.send') send(): void {}
}

const record = (overrides: Partial<ThrottlerStorageRecord> = {}): ThrottlerStorageRecord => ({
  totalHits: 1,
  timeToExpire: 10,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...overrides,
});

function wsContext(
  socket: Record<string, unknown>,
  handler = Gateway.prototype.onMessage,
  type = 'ws',
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => Gateway,
    switchToWs: () => ({ getClient: () => socket, getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

async function createGuard() {
  const increment = vi.fn<ThrottlerStorage['increment']>(async () => record());
  const guard = new WsThrottlerGuard(
    {
      throttlers: [
        { name: THROTTLER.USER, ttl: 60_000, limit: 100 },
        { name: THROTTLER.ROUTE, ttl: 60_000, limit: 100 },
      ],
    },
    { increment },
    new Reflector(),
  );
  const registry = new RateLimitPolicyRegistry();
  registry.register([{ name: 'chat.send', key: 'user', limit: 5, ttlMs: 10_000 }]);
  Reflect.set(guard, 'policies', registry);
  await guard.onModuleInit();
  return { guard, increment };
}

describe('WsThrottlerGuard', () => {
  it('charges the socket user to the global user budget and the message policy', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      wsContext(
        { data: { user: { id: 'u-1' } }, handshake: { address: '1.2.3.4' } },
        Gateway.prototype.send,
      ),
    );
    expect(increment.mock.calls).toEqual(
      expect.arrayContaining([
        [rateLimitKey('user', 'global', 'user:u-1'), 60_000, 100, 60_000, 'user'],
        [rateLimitKey('route', 'chat.send', 'user:u-1'), 10_000, 5, 10_000, 'route'],
      ]),
    );
  });

  it('falls back to the handshake address', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(wsContext({ data: {}, handshake: { address: '5.6.7.8' } }));
    expect(increment.mock.calls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'ip:5.6.7.8'));
  });

  it('raises ThrottlerException (429) when blocked', async () => {
    const { guard, increment } = await createGuard();
    increment.mockResolvedValue(record({ isBlocked: true, timeToBlockExpire: 3 }));
    await expect(
      guard.canActivate(wsContext({ data: { user: { id: 'u-1' } } })),
    ).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('skips every transport but ws', async () => {
    const { guard, increment } = await createGuard();
    await expect(
      guard.canActivate(wsContext({}, Gateway.prototype.onMessage, 'http')),
    ).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });
});
```

In `libs/config/src/namespaces/namespaces.spec.ts`, add `import { throttleConfig } from './throttle.config.js';`
after the `storageConfig` import, and add this assertion at the end of the
`'auth, throttle-adjacent and graphql defaults'` test (later tasks replace it as the namespace grows):

```ts
expect(throttleConfig.parse({})).toEqual({
  ttlMs: 60_000,
  limit: 300,
  authTtlMs: 60_000,
  authLimit: 10,
});
```

In `libs/redis/src/throttler/app-throttler.module.spec.ts`:

- Replace `storage.increment('k', 1_000, 5, 1_000, 'default')` with `storage.increment('k', 1_000, 5, 1_000, 'user')`.
- Append these two tests inside the `describe` block (add the imports `Controller, Post` from `@nestjs/common`,
  `RateLimit` from `./rate-limit.decorator.js`, `RateLimitModule` from `./rate-limit.module.js` and
  `RateLimitPolicyRegistry` from `./rate-limit-policy.js`):

```ts
it('collects RateLimitModule.forFeature policies into the global registry', async () => {
  @Module({
    imports: [
      RateLimitModule.forFeature({
        useFactory: () => [{ name: 'test.thing', key: 'user', limit: 2, ttlMs: 1_000 }],
      }),
    ],
  })
  class FeatureModule {}
  @Module({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      FakeRedisModule,
      AppThrottlerModule.forRootAsync(),
      FeatureModule,
    ],
  })
  class TestModule {}

  app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  expect(app.get(RateLimitPolicyRegistry).require('test.thing')).toMatchObject({ limit: 2 });
});

it('refuses to boot when @RateLimit names an unregistered policy', async () => {
  @Controller('x')
  class BadController {
    @Post() @RateLimit('test.missing') handle(): void {}
  }
  @Module({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      FakeRedisModule,
      AppThrottlerModule.forRootAsync(),
    ],
    controllers: [BadController],
  })
  class TestModule {}

  await expect(
    NestFactory.createApplicationContext(TestModule, { logger: false, abortOnError: false }),
  ).rejects.toThrow('@RateLimit names unregistered policies: test.missing');
});
```

In the test `'can leave APP_GUARD registration to the app'`, replace `expect(dynamic.providers).toEqual([AppThrottlerGuard]);` with
`expect(dynamic.providers).not.toContainEqual(expect.objectContaining({ provide: APP_GUARD }));`, replace
`expect(AppThrottlerModule.forRootAsync().providers).toHaveLength(2);` with
`expect(AppThrottlerModule.forRootAsync().providers).toContainEqual({ provide: APP_GUARD, useExisting: AppThrottlerGuard });`,
and import `APP_GUARD` from `@nestjs/core`.

`domains/notifications/src/presentation/ws/notifications-rate-limit.spec.ts`:

```ts
import { RATE_LIMIT_POLICY_KEY } from '@platform/redis';
import { describe, expect, it } from 'vitest';
import { NotificationsGateway } from './notifications.gateway.js';
import {
  NOTIFICATIONS_RATE_LIMITS,
  notificationsRateLimitPolicies,
} from './notifications-rate-limit.js';
import { notificationsRateLimitConfig } from './notifications-rate-limit.config.js';

describe('notifications rate-limit policies', () => {
  it('reads NOTIFICATIONS_MARK_READ_* with the previous 30 per 10 s defaults', () => {
    expect(notificationsRateLimitPolicies(notificationsRateLimitConfig.parse({}))).toEqual([
      { name: 'notifications.mark-read', key: 'user', limit: 30, ttlMs: 10_000 },
    ]);
    const tuned = notificationsRateLimitConfig.parse({
      NOTIFICATIONS_MARK_READ_LIMIT: '5',
      NOTIFICATIONS_MARK_READ_TTL_MS: '1000',
    });
    expect(notificationsRateLimitPolicies(tuned)[0]).toMatchObject({ limit: 5, ttlMs: 1_000 });
  });

  it('markRead uses the notifications.mark-read policy', () => {
    expect(
      Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, NotificationsGateway.prototype.markRead),
    ).toBe(NOTIFICATIONS_RATE_LIMITS.MARK_READ);
  });
});
```

In `domains/billing/src/presentation/http/billing.controller.spec.ts`, replace the test at `:234-237` with:

```ts
it('skips every rate limiter', () => {
  const handler = Reflect.get(BillingController.prototype, 'handleStripeWebhook') as object;
  for (const name of RATE_LIMIT_THROTTLERS) {
    expect(Reflect.getMetadata(`THROTTLER:SKIP${name}`, handler)).toBe(true);
  }
});
```

Add `import { RATE_LIMIT_THROTTLERS } from '@platform/redis';` to that spec's imports.

- [ ] **Step 2: Run them; expect FAIL.**
      `npx vitest run --project redis src/throttler` and `npx vitest run --project notifications src/presentation/ws/notifications-rate-limit.spec.ts`
      and `npx vitest run --project billing src/presentation/http/billing.controller.spec.ts`
      and `npx vitest run --project config src/namespaces`.
      Expected: FAIL. The new modules do not exist (`Cannot find module './rate-limit-key.util.js'`, `'./rate-limit-policy.js'`, …), the billing spec has no `RATE_LIMIT_THROTTLERS` export, and `throttleConfig.parse({}).limit` is still 100.

- [ ] **Step 3: Implement.**

Replace `libs/redis/src/throttler/throttle.constants.ts` with:

```ts
/**
 * Named throttlers (spec §11). Each guard enforces its own subset (`RateLimitGuardBase.enforced`):
 * `ip` before authentication, `user`/`route`/`auth` after it, `user`/`route` per WebSocket message.
 * `lockout` is a bucket the `auth` throttler maintains, not a configured throttler.
 */
export const THROTTLER = {
  IP: 'ip',
  USER: 'user',
  ROUTE: 'route',
  AUTH: 'auth',
  LOCKOUT: 'lockout',
} as const;

export type ThrottlerName = (typeof THROTTLER)[keyof typeof THROTTLER];

/** Every configured throttler name: `SkipRateLimit()` skips all of them. */
export const RATE_LIMIT_THROTTLERS: readonly ThrottlerName[] = Object.freeze([
  THROTTLER.IP,
  THROTTLER.USER,
  THROTTLER.ROUTE,
  THROTTLER.AUTH,
]);

/** Scope of the budgets that span every route (`ip`, `user`). */
export const GLOBAL_SCOPE = 'global';

/** Route metadata set by `@RateLimit(policy)` (read by `RateLimitGuardBase`). */
export const RATE_LIMIT_POLICY_KEY = 'app:rateLimitPolicy';

/** Route metadata set by `@AuthThrottle()` (read by `AppThrottlerGuard`). Removed by task C2. */
export const AUTH_THROTTLE_KEY = 'app:authThrottle';

/**
 * Ops endpoints that must never be rate limited: probes and scrapers hit them constantly from a
 * handful of IPs, and a 429 on `/health/ready` would take the pod out of rotation. Matched as path
 * prefixes on a `/` boundary (`/health` covers `/health/live`, not `/healthz`).
 */
export const DEFAULT_THROTTLE_EXEMPT_PATHS: readonly string[] = [
  '/health',
  '/metrics',
  '/docs',
  '/openapi.json',
  '/openapi.yaml',
  '/swagger',
];
```

`libs/redis/src/throttler/rate-limit-key.util.ts`:

```ts
import { createHash } from 'node:crypto';

/**
 * Bucket key = sha256 of `[throttler, scope, tracker]` (JSON-encoded, so no component can forge
 * another by containing a separator). Scope is a policy name or `global`, never a class or handler
 * name, so every route sharing a policy shares the bucket (F17). The digest keeps PII (IPs, ids,
 * email hashes) out of Redis key names.
 */
export function rateLimitKey(throttler: string, scope: string, tracker: string): string {
  return createHash('sha256')
    .update(JSON.stringify([throttler, scope, tracker]))
    .digest('hex');
}
```

`libs/redis/src/throttler/rate-limit-policy.ts`:

```ts
import { Injectable } from '@nestjs/common';

/** What a policy bucket is keyed by: client IP, user (falling back to IP), or credential + IP. */
export type RateLimitKeyKind = 'ip' | 'user' | 'credentials';

/** Consecutive non-successful attempts per account before it is refused for `durationMs`. */
export interface RateLimitLockout {
  readonly threshold: number;
  readonly durationMs: number;
}

/** A named route policy, declared by the owning domain (`RateLimitModule.forFeature`). */
export interface RateLimitPolicy {
  /** `<domain>.<name>`, lower-case kebab parts, e.g. `orders.credentials`, `files.upload`. */
  readonly name: string;
  readonly key: RateLimitKeyKind;
  readonly limit: number;
  readonly ttlMs: number;
  /** Block after the limit is exceeded (default `ttlMs`; `0` = reject until the window resets). */
  readonly blockMs?: number;
  /** Body / GraphQL input field holding the account identifier (default `email`). */
  readonly credentialField?: string;
  readonly lockout?: RateLimitLockout;
}

export const RATE_LIMIT_POLICY_NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

const isPositiveInt = (value: number): boolean => Number.isInteger(value) && value >= 1;

function assertValidPolicy(policy: RateLimitPolicy): void {
  const fail = (why: string): never => {
    throw new Error(`Invalid rate-limit policy "${policy.name}": ${why}`);
  };
  if (!RATE_LIMIT_POLICY_NAME.test(policy.name)) {
    fail('name must look like "<domain>.<name>" (lower-case kebab parts)');
  }
  if (!isPositiveInt(policy.limit)) fail('limit must be an integer >= 1');
  if (!isPositiveInt(policy.ttlMs)) fail('ttlMs must be an integer >= 1');
  if (policy.blockMs !== undefined && !(Number.isInteger(policy.blockMs) && policy.blockMs >= 0)) {
    fail('blockMs must be an integer >= 0');
  }
  if (
    policy.key !== 'credentials' &&
    (policy.lockout !== undefined || policy.credentialField !== undefined)
  ) {
    fail('lockout and credentialField need key "credentials"');
  }
  if (
    policy.lockout !== undefined &&
    !(isPositiveInt(policy.lockout.threshold) && isPositiveInt(policy.lockout.durationMs))
  ) {
    fail('lockout threshold and durationMs must be integers >= 1');
  }
}

/** Process-wide registry of named policies (provided globally by `AppThrottlerModule`). */
@Injectable()
export class RateLimitPolicyRegistry {
  private readonly policies = new Map<string, RateLimitPolicy>();

  register(policies: readonly RateLimitPolicy[]): void {
    for (const policy of policies) {
      assertValidPolicy(policy);
      if (this.policies.has(policy.name)) {
        throw new Error(`Rate-limit policy "${policy.name}" is registered twice`);
      }
      this.policies.set(policy.name, Object.freeze({ ...policy }));
    }
  }

  get(name: string): RateLimitPolicy | undefined {
    return this.policies.get(name);
  }

  require(name: string): RateLimitPolicy {
    const policy = this.policies.get(name);
    if (policy === undefined) throw new Error(`Unknown rate-limit policy "${name}"`);
    return policy;
  }

  names(): string[] {
    return [...this.policies.keys()].sort();
  }
}
```

`libs/redis/src/throttler/rate-limit.decorator.ts`:

```ts
import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { RATE_LIMIT_POLICY_KEY, RATE_LIMIT_THROTTLERS } from './throttle.constants.js';

/**
 * Applies a named policy (registered with `RateLimitModule.forFeature`) on top of the global
 * budgets. Every route naming the same policy shares its buckets.
 */
export const RateLimit = (policy: string): CustomDecorator<string> =>
  SetMetadata(RATE_LIMIT_POLICY_KEY, policy);

/**
 * Skips EVERY named throttler (ip, user, route, auth, tenant). Use it instead of `@SkipThrottle()`,
 * whose default only skips a throttler called `default`, which no longer exists.
 */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SkipThrottle(Object.fromEntries(RATE_LIMIT_THROTTLERS.map((name) => [name, true])));
```

`libs/redis/src/throttler/rate-limit.module.ts`:

```ts
import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { type RateLimitPolicy, RateLimitPolicyRegistry } from './rate-limit-policy.js';

export interface RateLimitFeatureOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  /** Receives the `inject`ed values; returns the domain's policies (limits from its config). */
  useFactory: (...deps: never[]) => readonly RateLimitPolicy[];
}

let featureSequence = 0;

/**
 * How a domain declares its named policies:
 * `RateLimitModule.forFeature({ imports: [ConfigModule.forFeature(cfg)], inject: [cfg.KEY], useFactory })`.
 * The registry is optional so domain modules still compose in tests without `AppThrottlerModule`
 * (then nothing is throttled anyway).
 */
@Module({})
export class RateLimitModule {
  static forFeature(options: RateLimitFeatureOptions): DynamicModule {
    featureSequence += 1;
    const token = `RATE_LIMIT_FEATURE_${featureSequence}`;
    return {
      module: RateLimitModule,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: token,
          inject: [{ token: RateLimitPolicyRegistry, optional: true }, ...(options.inject ?? [])],
          useFactory: (registry: RateLimitPolicyRegistry | undefined, ...deps: unknown[]): true => {
            const policies = Reflect.apply(
              options.useFactory,
              undefined,
              deps,
            ) as readonly RateLimitPolicy[];
            registry?.register(policies);
            return true;
          },
        },
      ],
    };
  }
}
```

`libs/redis/src/throttler/rate-limit-policy.validator.ts`:

```ts
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { RATE_LIMIT_POLICY_KEY } from './throttle.constants.js';

/**
 * Fails boot when a controller, resolver or gateway names a policy nobody registered, so a typo
 * can't turn into a 500 on the first request (or silently skip a limit).
 */
@Injectable()
export class RateLimitPolicyValidator implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly registry: RateLimitPolicyRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const unknown = new Set<string>();
    const check = (name: string | undefined): void => {
      if (name !== undefined && this.registry.get(name) === undefined) unknown.add(name);
    };
    for (const wrapper of [...this.discovery.getControllers(), ...this.discovery.getProviders()]) {
      const instance: unknown = wrapper.instance;
      const metatype = wrapper.metatype;
      if (typeof instance !== 'object' || instance === null || !metatype) continue;
      check(this.reflector.get<string | undefined>(RATE_LIMIT_POLICY_KEY, metatype));
      const prototype: object = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler: unknown = Reflect.get(prototype, method);
        if (typeof handler === 'function') {
          check(this.reflector.get<string | undefined>(RATE_LIMIT_POLICY_KEY, handler));
        }
      }
    }
    if (unknown.size > 0) {
      throw new Error(
        `@RateLimit names unregistered policies: ${[...unknown].sort().join(', ')}. ` +
          'Register them with RateLimitModule.forFeature().',
      );
    }
  }
}
```

`libs/redis/src/throttler/rate-limit-guard.base.ts`:

```ts
import { type ExecutionContext, Inject } from '@nestjs/common';
import { normalizeIp, ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { rateLimitKey } from './rate-limit-key.util.js';
import { type RateLimitPolicy, RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { GLOBAL_SCOPE, RATE_LIMIT_POLICY_KEY, THROTTLER } from './throttle.constants.js';
import { authenticatedUserId } from './throttle-tracker.util.js';

/** Who a request or message is charged to. `user` is read structurally (`{ id }`). */
export interface RateLimitSubject {
  readonly user?: unknown;
  readonly ip?: string | undefined;
}

/** One bucket a throttler charges for one request. */
export interface RateLimitBucket {
  throttler: string;
  scope: string;
  tracker: string;
  limit: number;
  ttlMs: number;
  blockMs: number;
}

/**
 * Shared logic of the HTTP/GraphQL, pre-auth IP and WebSocket guards. `ThrottlerGuard.canActivate`
 * loops over EVERY configured throttler; each subclass enforces only the names in `enforced` and
 * maps the rest to "not charged". Keys are scope-based (`rateLimitKey`), never class/handler-based.
 */
export abstract class RateLimitGuardBase extends ThrottlerGuard {
  @Inject(RateLimitPolicyRegistry)
  protected readonly policies!: RateLimitPolicyRegistry;

  /** Throttler names this guard charges. */
  protected abstract readonly enforced: ReadonlySet<string>;

  protected abstract subjectOf(context: ExecutionContext): RateLimitSubject;

  /** Where `Retry-After` goes (HTTP reply); `undefined` for transports without headers. */
  protected responseOf(_context: ExecutionContext): Record<string, unknown> | undefined {
    return undefined;
  }

  /** `true` → the request is not charged at all (ignored user agents). */
  protected isIgnored(_context: ExecutionContext): boolean {
    return false;
  }

  protected policyFor(context: ExecutionContext): RateLimitPolicy | undefined {
    const name = this.reflector.getAllAndOverride<string | undefined>(RATE_LIMIT_POLICY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return name === undefined ? undefined : this.policies.require(name);
  }

  protected ipTracker(ip: string | undefined): string {
    return ip ? `ip:${normalizeIp(ip, this.ipv6SubnetPrefix)}` : 'ip:unknown';
  }

  protected userTracker(subject: RateLimitSubject): string {
    const id = authenticatedUserId(subject.user);
    return id ? `user:${id}` : this.ipTracker(subject.ip);
  }

  /** The bucket `request.throttler` charges, or `undefined` when it does not apply here. */
  protected bucketFor(
    request: ThrottlerRequest,
    subject: RateLimitSubject,
  ): RateLimitBucket | undefined {
    const name = request.throttler.name ?? THROTTLER.USER;
    const global = {
      throttler: name,
      scope: GLOBAL_SCOPE,
      limit: request.limit,
      ttlMs: request.ttl,
      blockMs: request.blockDuration,
    };
    switch (name) {
      case THROTTLER.IP:
        return { ...global, tracker: this.ipTracker(subject.ip) };
      case THROTTLER.USER:
        return { ...global, tracker: this.userTracker(subject) };
      case THROTTLER.ROUTE: {
        const policy = this.policyFor(request.context);
        if (policy === undefined || policy.key === 'credentials') return undefined;
        return {
          throttler: name,
          scope: policy.name,
          tracker: policy.key === 'ip' ? this.ipTracker(subject.ip) : this.userTracker(subject),
          limit: policy.limit,
          ttlMs: policy.ttlMs,
          blockMs: policy.blockMs ?? policy.ttlMs,
        };
      }
      default:
        return undefined;
    }
  }

  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const name = request.throttler.name ?? THROTTLER.USER;
    if (!this.enforced.has(name) || this.isIgnored(request.context)) return true;
    const bucket = this.bucketFor(request, this.subjectOf(request.context));
    if (bucket === undefined) return true;
    await this.charge(request.context, bucket);
    return true;
  }

  /** Increments `bucket`; throws `ThrottlerException` (429, `Retry-After`) when it is blocked. */
  protected async charge(context: ExecutionContext, bucket: RateLimitBucket): Promise<void> {
    const key = rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker);
    const record = await this.storageService.increment(
      key,
      bucket.ttlMs,
      bucket.limit,
      bucket.blockMs,
      bucket.throttler,
    );
    if (!record.isBlocked) return;
    const res = this.responseOf(context);
    if (res !== undefined) this.setResponseHeader(res, 'Retry-After', record.timeToBlockExpire);
    await this.throwThrottlingException(context, {
      limit: bucket.limit,
      ttl: bucket.ttlMs,
      key,
      tracker: bucket.tracker,
      ...record,
    });
  }
}
```

Replace `libs/redis/src/throttler/app-throttler.guard.ts` with:

```ts
import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { getContextType } from '@platform/common';
import { type ThrottleConfig, throttleConfig } from '@platform/config';
import {
  type RateLimitBucket,
  RateLimitGuardBase,
  type RateLimitSubject,
} from './rate-limit-guard.base.js';
import { AUTH_THROTTLE_KEY, THROTTLER } from './throttle.constants.js';

type HeaderSink = Record<string, unknown>;

/** graphql-ws subscriptions have no reply: give the guard a sink so header writes are no-ops. */
const NOOP_RESPONSE: HeaderSink = Object.freeze({ header: (): undefined => undefined });
const EMPTY_REQUEST: HeaderSink = Object.freeze({ headers: {} });

/** GraphQL context shape built by @platform/graphql (`{ req, reply }`); typed structurally. */
interface GqlContextLike {
  req?: HeaderSink;
  reply?: HeaderSink;
}

/**
 * Global throttler guard for HTTP and GraphQL (ws: `WsThrottlerGuard`; rpc: limited at the edge).
 * Charges the `user` budget (user id, else client IP; scope `global`) and the `route` budget of a
 * `@RateLimit` policy. Register it AFTER `AuthModule` so `req.user` is set.
 */
@Injectable()
export class AppThrottlerGuard extends RateLimitGuardBase {
  // Property injection keeps ThrottlerGuard's own (decorated) constructor untouched.
  @Inject(throttleConfig.KEY)
  private readonly limits!: ThrottleConfig;

  protected override readonly enforced: ReadonlySet<string> = new Set<string>([
    THROTTLER.USER,
    THROTTLER.ROUTE,
  ]);

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const type = getContextType(context);
    return type === 'rpc' || type === 'ws';
  }

  protected override getRequestResponse(context: ExecutionContext): {
    req: HeaderSink;
    res: HeaderSink;
  } {
    if (getContextType(context) === 'graphql') {
      const gql = context.getArgByIndex<GqlContextLike | undefined>(2);
      return { req: gql?.req ?? EMPTY_REQUEST, res: gql?.reply ?? NOOP_RESPONSE };
    }
    return super.getRequestResponse(context);
  }

  protected override subjectOf(context: ExecutionContext): RateLimitSubject {
    const { req } = this.getRequestResponse(context);
    return { user: req['user'], ip: typeof req['ip'] === 'string' ? req['ip'] : undefined };
  }

  protected override responseOf(context: ExecutionContext): HeaderSink {
    return this.getRequestResponse(context).res;
  }

  protected override isIgnored(context: ExecutionContext): boolean {
    const agents = this.commonOptions.ignoreUserAgents;
    if (!Array.isArray(agents) || agents.length === 0) return false;
    const headers = this.getRequestResponse(context).req['headers'] as
      Record<string, unknown> | undefined;
    const agent = headers?.['user-agent'];
    return typeof agent === 'string' && agents.some((pattern) => pattern.test(agent));
  }

  protected override bucketFor(
    request: ThrottlerRequest,
    subject: RateLimitSubject,
  ): RateLimitBucket | undefined {
    const bucket = super.bucketFor(request, subject);
    // Interim until task C2: @AuthThrottle() routes share ONE `auth` scope (F17) with the
    // THROTTLE_AUTH_* window instead of the global user budget.
    if (bucket?.throttler === THROTTLER.USER && this.isAuthThrottled(request.context)) {
      const { authLimit, authTtlMs } = this.limits;
      return { ...bucket, scope: 'auth', limit: authLimit, ttlMs: authTtlMs, blockMs: authTtlMs };
    }
    return bucket;
  }

  private isAuthThrottled(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(AUTH_THROTTLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
```

Replace `libs/redis/src/throttler/ws-throttler.guard.ts` with:

```ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { getContextType } from '@platform/common';
import { RateLimitGuardBase, type RateLimitSubject } from './rate-limit-guard.base.js';
import { THROTTLER } from './throttle.constants.js';

/** The parts of a socket.io `Socket` read here (structural → independent of socket.io copies). */
interface SocketLike {
  data?: { user?: unknown } | null;
  handshake?: { address?: string };
}

/**
 * Per-MESSAGE rate limiting for WebSocket gateways (the global `AppThrottlerGuard` skips `ws`).
 * Apply it on the gateway, never as APP_GUARD: `@UseGuards(WsThrottlerGuard)`, with
 * `@RateLimit('<domain>.<name>')` on handlers that need their own budget. Charges the global `user`
 * budget and the handler's policy. A blocked message raises `ThrottlerException` (429), which
 * `@UseWsExceptionFilter()` delivers as `{ ok: false, error }`. Requires `AppThrottlerModule`.
 */
@Injectable()
export class WsThrottlerGuard extends RateLimitGuardBase {
  protected override readonly enforced: ReadonlySet<string> = new Set<string>([
    THROTTLER.USER,
    THROTTLER.ROUTE,
  ]);

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return getContextType(context) !== 'ws';
  }

  protected override subjectOf(context: ExecutionContext): RateLimitSubject {
    const client = context.switchToWs().getClient<SocketLike | undefined>();
    return { user: client?.data?.user, ip: client?.handshake?.address };
  }
}
```

Replace `libs/redis/src/throttler/app-throttler.module.ts` with:

```ts
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';
import { type ThrottleConfig, throttleConfig } from '@platform/config';
import type { Redis } from 'ioredis';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { REDIS_CLIENT } from '../redis.constants.js';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { RateLimitPolicyValidator } from './rate-limit-policy.validator.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { DEFAULT_THROTTLE_EXEMPT_PATHS, THROTTLER } from './throttle.constants.js';
import { createThrottleSkipIf } from './throttle-exempt.util.js';
import { WsThrottlerGuard } from './ws-throttler.guard.js';

export interface AppThrottlerModuleOptions {
  /** Path prefixes never rate limited. Default `DEFAULT_THROTTLE_EXEMPT_PATHS` (ops endpoints). */
  exemptPaths?: readonly string[];
  /** User agents never rate limited (e.g. `[/kube-probe/i]`). Default: none. */
  ignoreUserAgents?: RegExp[];
  /** See `RedisThrottlerStorageOptions.failOpen`. Default `true`. */
  failOpen?: boolean;
  /**
   * Register `AppThrottlerGuard` as `APP_GUARD` (default `true`). Set `false` to register it
   * yourself — e.g. to control its position relative to other global guards.
   */
  globalGuard?: boolean;
}

/**
 * Redis-backed rate limiting for every replica (global module):
 * - `user`: `THROTTLE_LIMIT` per `THROTTLE_TTL_MS`, one budget per user (else client IP) across routes;
 * - `route`: named policies (`@RateLimit`), declared by domains with `RateLimitModule.forFeature`;
 * - `@SkipRateLimit()` opts out; ops paths are exempt.
 * Requires `RedisModule` (global). Import `AuthModule` BEFORE this module so `req.user` is set.
 */
@Module({})
export class AppThrottlerModule {
  static forRootAsync(options: AppThrottlerModuleOptions = {}): DynamicModule {
    const skipIf = createThrottleSkipIf(options.exemptPaths ?? DEFAULT_THROTTLE_EXEMPT_PATHS);
    const providers: Provider[] = [
      AppThrottlerGuard,
      WsThrottlerGuard,
      RateLimitPolicyRegistry,
      RateLimitPolicyValidator,
    ];
    if (options.globalGuard ?? true) {
      providers.push({ provide: APP_GUARD, useExisting: AppThrottlerGuard });
    }
    return {
      module: AppThrottlerModule,
      global: true,
      imports: [
        DiscoveryModule,
        ConfigModule.forFeature(throttleConfig),
        // ThrottlerModule is @Global: its options + storage tokens are visible to every guard.
        ThrottlerModule.forRootAsync({
          imports: [ConfigModule.forFeature(throttleConfig)],
          inject: [throttleConfig.KEY, REDIS_CLIENT, RedisKeyService],
          useFactory: (
            config: ThrottleConfig,
            redis: Redis,
            keys: RedisKeyService,
          ): ThrottlerModuleOptions => ({
            throttlers: [
              { name: THROTTLER.USER, ttl: config.ttlMs, limit: config.limit },
              // Real values come from the route's @RateLimit policy (RateLimitGuardBase.bucketFor).
              { name: THROTTLER.ROUTE, ttl: config.ttlMs, limit: config.limit },
            ],
            storage: new RedisThrottlerStorage(
              redis,
              keys,
              options.failOpen === undefined ? {} : { failOpen: options.failOpen },
            ),
            skipIf,
            ...(options.ignoreUserAgents ? { ignoreUserAgents: options.ignoreUserAgents } : {}),
          }),
        }),
      ],
      providers,
      exports: [AppThrottlerGuard, WsThrottlerGuard, RateLimitPolicyRegistry],
    };
  }
}
```

In `libs/redis/src/index.ts`:

- Replace the block

```ts
export {
  AUTH_THROTTLE_KEY,
  DEFAULT_THROTTLE_EXEMPT_PATHS,
  DEFAULT_THROTTLER_NAME,
} from './throttler/throttle.constants.js';
```

with

```ts
export {
  AUTH_THROTTLE_KEY,
  DEFAULT_THROTTLE_EXEMPT_PATHS,
  GLOBAL_SCOPE,
  RATE_LIMIT_POLICY_KEY,
  RATE_LIMIT_THROTTLERS,
  THROTTLER,
  type ThrottlerName,
} from './throttler/throttle.constants.js';
export { RateLimit, SkipRateLimit } from './throttler/rate-limit.decorator.js';
export { rateLimitKey } from './throttler/rate-limit-key.util.js';
export {
  RATE_LIMIT_POLICY_NAME,
  type RateLimitKeyKind,
  type RateLimitLockout,
  type RateLimitPolicy,
  RateLimitPolicyRegistry,
} from './throttler/rate-limit-policy.js';
export { RateLimitModule, type RateLimitFeatureOptions } from './throttler/rate-limit.module.js';
export {
  type RateLimitBucket,
  RateLimitGuardBase,
  type RateLimitSubject,
} from './throttler/rate-limit-guard.base.js';
```

- Change the comment on `:8` to `// Re-exported for apps; prefer RateLimit/SkipRateLimit (they know every throttler name).`

`domains/notifications/src/presentation/ws/notifications-rate-limit.config.ts`:

```ts
import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const notificationsRateLimitEnvSchema = z
  .object({
    NOTIFICATIONS_MARK_READ_LIMIT: zInt(30, { min: 1 }),
    NOTIFICATIONS_MARK_READ_TTL_MS: zInt(10_000, { min: 1 }),
  })
  .transform((env) => ({
    markReadLimit: env.NOTIFICATIONS_MARK_READ_LIMIT,
    markReadTtlMs: env.NOTIFICATIONS_MARK_READ_TTL_MS,
  }));

/** Named rate-limit policies of the notifications domain (gateway, monolith). */
export const notificationsRateLimitConfig = defineConfigNamespace(
  'notificationsRateLimit',
  notificationsRateLimitEnvSchema,
);
export type NotificationsRateLimitConfig = ConfigType<typeof notificationsRateLimitConfig>;
```

`domains/notifications/src/presentation/ws/notifications-rate-limit.ts`:

```ts
import { ConfigModule } from '@nestjs/config';
import { RateLimitModule, type RateLimitPolicy } from '@platform/redis';
import {
  type NotificationsRateLimitConfig,
  notificationsRateLimitConfig,
} from './notifications-rate-limit.config.js';

export const NOTIFICATIONS_RATE_LIMITS = { MARK_READ: 'notifications.mark-read' } as const;

export function notificationsRateLimitPolicies(
  cfg: NotificationsRateLimitConfig,
): RateLimitPolicy[] {
  return [
    {
      name: NOTIFICATIONS_RATE_LIMITS.MARK_READ,
      key: 'user',
      limit: cfg.markReadLimit,
      ttlMs: cfg.markReadTtlMs,
    },
  ];
}

export const NotificationsRateLimitModule = RateLimitModule.forFeature({
  imports: [ConfigModule.forFeature(notificationsRateLimitConfig)],
  inject: [notificationsRateLimitConfig.KEY],
  useFactory: notificationsRateLimitPolicies,
});
```

In `domains/notifications/src/presentation/ws/notifications.gateway.ts`:

- `import { Throttle, WsThrottlerGuard } from '@platform/redis';` → `import { RateLimit, WsThrottlerGuard } from '@platform/redis';`
- add `import { NOTIFICATIONS_RATE_LIMITS } from './notifications-rate-limit.js';`
- `@Throttle({ default: { limit: 30, ttl: 10_000 } })` → `@RateLimit(NOTIFICATIONS_RATE_LIMITS.MARK_READ)`.

In `domains/notifications/src/notifications-api.module.ts`:

- add `import { NotificationsRateLimitModule } from './presentation/ws/notifications-rate-limit.js';`;
- `imports: [NotificationsCoreModule],` → `imports: [NotificationsCoreModule, NotificationsRateLimitModule],`;
- `imports: [GrpcClientsModule.register(target)],` → `imports: [GrpcClientsModule.register(target), NotificationsRateLimitModule],`.
- If G plan Task 3 already changed these arrays (for example `forLocal()` no longer imports `NotificationsCoreModule`),
  append `NotificationsRateLimitModule` as the last element of both `imports:` arrays as they stand.

Export the namespace from the package entry that the gateway imports domain config from:

- If `domains/notifications/src/api/index.ts` exists (G plan Task 3 merged first), add
  `export { notificationsRateLimitConfig, type NotificationsRateLimitConfig } from '../presentation/ws/notifications-rate-limit.config.js';`
  there. It is presentation config loaded by `NotificationsApiModule`, like `notificationsGrpcClientConfig` (G's
  placement rule), and the root re-exports `./api`.
- Otherwise add
  `export { notificationsRateLimitConfig, type NotificationsRateLimitConfig } from './presentation/ws/notifications-rate-limit.config.js';`
  to `domains/notifications/src/index.ts`.

In `libs/config/src/namespaces/throttle.config.ts`, change `THROTTLE_LIMIT: zInt(100, { min: 1 }),` to
`THROTTLE_LIMIT: zInt(300, { min: 1 }),`. No other config code changes in C1.

In `domains/billing/src/presentation/http/billing.controller.ts`:

- delete `import { SkipThrottle } from '@nestjs/throttler';`;
- add `import { SkipRateLimit } from '@platform/redis';`;
- `@SkipThrottle()` → `@SkipRateLimit()`.

In `apps/gateway/test/env-example.spec.ts` and `apps/monolith/test/env-example.spec.ts`:

- gateway: add `notificationsRateLimitConfig` to the import statement that already brings in
  `notificationsGrpcClientConfig` (`'@domain/notifications'` today, `'@domain/notifications/api'` after G Task 3);
- monolith: new line `import { notificationsRateLimitConfig } from '@domain/notifications';` after the
  `@domain/identity` import;
- append it to `NAMESPACES`.

In the root `.env.example`, change `# THROTTLE_LIMIT=100` (`:195`) to `# THROTTLE_LIMIT=300`, then, after the throttle
section (after the `# THROTTLE_AUTH_LIMIT=10` line, `:198`), add:

```
# ── notificationsRateLimit: named WebSocket policies (gateway, monolith) ─────────────────────
# notifications.mark-read: markRead messages per user per window.
# NOTIFICATIONS_MARK_READ_LIMIT=30
# NOTIFICATIONS_MARK_READ_TTL_MS=10000
```

- [ ] **Step 4: Run the tests; expect PASS.**
      `npx vitest run --project redis` and `npx vitest run --project notifications` and `npx vitest run --project billing`
      and `npx vitest run --project config`.
      Expected: PASS.

- [ ] **Step 5: Wider checks.**
      `npx biome check --write libs/redis/src domains/notifications/src domains/billing/src apps/gateway/test apps/monolith/test`
      then `npx vitest run --project bootstrap src/integration.smoke.spec.ts`. Expected: PASS. The `@AuthThrottle` smoke
      test still holds, because the window now lives in the shared `auth` scope.
      Then run `npx vitest run --project gateway --project monolith`, `node scripts/check-env-example.mjs` and `bun run check`.
      Expected: all PASS, and `Layer boundaries OK`.
      Then run `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off). Expected: PASS.
      The `user` budget is now shared across routes, so the e2e suites raise it out of the way: in
      `apps/monolith/test/support/e2e-env.ts` (`MONOLITH_E2E_ENV`) and `apps/gateway/test/support/e2e-env.ts`
      (`GATEWAY_E2E_ENV`), add `THROTTLE_LIMIT: '100000',` after `LOG_LEVEL: 'silent',`. The rate-limit e2e specs (C7)
      set their own small limits in their hoisted block.

- [ ] **Step 6: Commit.**

```bash
git add libs/redis/src libs/config/src domains/notifications/src domains/billing/src/presentation/http apps/gateway/test apps/monolith/test .env.example
git commit -m "feat(redis,notifications,billing): key rate limits by scope and add named policies" \
  -m "Buckets are sha256(throttler, scope, tracker): the user budget spans all routes (THROTTLE_LIMIT default 300), @AuthThrottle routes share one auth scope (F17), and domains declare @RateLimit policies via RateLimitModule.forFeature, validated at boot. SkipRateLimit replaces SkipThrottle."
```

### Task C2: `auth` throttler on sha256(email)+IP with a per-account lockout (C-3)

**Wave:** 1, after C1, in lane `c-throttle`.

**Why:**

- Spec §1 and §11 ask for credential endpoints to be limited by account and IP, with the bucket shared by REST and
  GraphQL, plus a failure-based lockout counter per account.
- Today `@AuthThrottle()` limits by user-or-IP only, so one attacker IP can try many accounts. It also has no
  lockout.

**How the lockout learns about failures without touching identity's handlers** (B2 rewrites login, spec §9):

- The guard counts every credential attempt as a failure before the handler runs.
- `LockoutResetInterceptor` clears the counter when the handler completes successfully.
- REST login fails inside `LocalAuthGuard` (`auth.controller.ts:82-83`), and route guards run after global guards
  but before interceptors, so a failed login never reaches the interceptor and the count stays.
- A GraphQL login that throws also skips the reset.
- So the counter is "consecutive failed attempts since the last success, within one `IDENTITY_LOCKOUT_MS` window",
  per account (any IP). The bucket is a fixed window (`THROTTLE_SCRIPT` sets the hits key's TTL to `durationMs` on the
  first hit), so failures spread over more than `IDENTITY_LOCKOUT_MS` do not add up.
- Threshold boundary (exact, from `THROTTLE_SCRIPT`: a hit is refused only when the count EXCEEDS the limit). With
  `IDENTITY_LOCKOUT_THRESHOLD=N`, attempts 1..N all reach the handler. A correct password on the N-th attempt (the
  one that reaches the threshold) succeeds and resets the count. Only after N consecutive failures is attempt N+1
  refused, even with the right password, for `IDENTITY_LOCKOUT_MS`; then a fresh window starts. The count is taken
  atomically in Lua, so N concurrent attempts admit at most N.
- The trade-off (anyone who knows an email can keep that account locked) is the spec's per-account choice; C7
  documents it in `docs/SECURITY.md`. B2 contract: a credential handler must THROW on failure. A handler that resolves
  counts as a success and resets the lockout.
- A locked account answers exactly like a rate-limited one (429 `RATE_LIMITED` + `Retry-After`), whether or not
  the account exists, so the lockout reveals nothing.

**Files:**

- Create: `libs/redis/src/throttler/credential-tracker.util.ts`, `libs/redis/src/throttler/credential-tracker.util.spec.ts`
- Create: `libs/redis/src/throttler/lockout.ts`, `libs/redis/src/throttler/lockout-reset.interceptor.ts`,
  `libs/redis/src/throttler/lockout-reset.interceptor.spec.ts`
- Modify: `libs/redis/package.json`: `dependencies` gains `"rxjs": "catalog:"` (catalog `7.8.2`, already used by
  `libs/common`). The interceptor imports `concatMap`, and `noUndeclaredDependencies` is an error. Ask the controller
  for `bun install` and stage `bun.lock`.
- Modify: `libs/redis/src/throttler/app-throttler.guard.ts`, `libs/redis/src/throttler/app-throttler.guard.spec.ts`,
  `libs/redis/src/throttler/app-throttler.module.ts`, `libs/redis/src/throttler/redis-throttler.storage.ts`,
  `libs/redis/src/throttler/redis-throttler.storage.spec.ts`, `libs/redis/src/throttler/throttle.constants.ts`,
  `libs/redis/src/index.ts`
- Delete: `libs/redis/src/throttler/auth-throttle.decorator.ts`
- Modify: `libs/config/src/namespaces/throttle.config.ts` (drop `THROTTLE_AUTH_*`; no deprecated alias, the rename
  is documented in C7), `libs/config/src/namespaces/namespaces.spec.ts`, `libs/redis/src/throttler/app-throttler.module.spec.ts`
- Create: `domains/identity/src/presentation/rate-limit/identity-rate-limit.config.ts`,
  `domains/identity/src/presentation/rate-limit/identity-rate-limit.ts`,
  `domains/identity/src/presentation/rate-limit/identity-rate-limit.spec.ts`
- Modify: `domains/identity/src/identity-api.module.ts`, `domains/identity/src/index.ts`,
  `domains/identity/src/presentation/http/auth.controller.ts`, `domains/identity/src/presentation/graphql/auth.resolver.ts`,
  `domains/identity/src/presentation/http/identity-http.spec.ts`
- Modify: `libs/bootstrap/src/integration.smoke.spec.ts` (`:56-57`, `:70`, `:111-117`, `:121-128`, `:366-375`)
- Modify: `apps/gateway/test/env-example.spec.ts`, `apps/monolith/test/env-example.spec.ts`, root `.env.example` (`:193-198`)

**Interfaces:**

- Consumes (from C1): `RateLimitGuardBase.bucketFor/charge/policyFor/ipTracker`, `RateLimitBucket`, `RateLimitPolicy`,
  `RateLimitModule.forFeature`, `rateLimitKey`, `THROTTLER`.
- Produces:
  ```ts
  export function normalizeCredential(value: unknown): string | undefined;   // NFKC, trim, lower-case, 1..320 chars
  export function credentialHash(value: unknown): string;                    // sha256 hex, or 'none'
  export function credentialFrom(source: unknown, field: string): unknown;   // body[field] ?? body.input[field]
  export function markLockoutAttempt(request: object, key: string): void;
  export function takeLockoutAttempts(request: object): string[] | undefined;
  export class LockoutResetInterceptor implements NestInterceptor;            // APP_INTERCEPTOR (AppThrottlerModule)
  RedisThrottlerStorage.reset(key: string, throttlerName: string): Promise<void>;
  export const IDENTITY_RATE_LIMITS: { readonly CREDENTIALS: 'identity.credentials' };     // @domain/identity (internal)
  export const identityRateLimitConfig; // namespace 'identityRateLimit': IDENTITY_CREDENTIALS_LIMIT (10), IDENTITY_CREDENTIALS_TTL_MS (60000), IDENTITY_LOCKOUT_THRESHOLD (10), IDENTITY_LOCKOUT_MS (900000)
  ```
- Removed: `AuthThrottle`, `AUTH_THROTTLE_KEY`, `ThrottleConfig.authTtlMs/authLimit`, `THROTTLE_AUTH_TTL_MS`, `THROTTLE_AUTH_LIMIT`.

- [ ] **Step 0: Dependency.** Add `"rxjs": "catalog:",` to `libs/redis/package.json` `dependencies`, after
      `"lodash-es"`, and ask the controller to run `bun install` (rxjs is already in `node_modules`, so the tests run
      before that).

- [ ] **Step 1: Write the failing tests.**

`libs/redis/src/throttler/credential-tracker.util.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { credentialFrom, credentialHash, normalizeCredential } from './credential-tracker.util.js';

describe('credential tracker', () => {
  it('normalises case, whitespace and Unicode compatibility forms', () => {
    expect(normalizeCredential('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeCredential('ａｌｉｃｅ@example.com')).toBe('alice@example.com'); // full-width → NFKC
    expect(credentialHash('Alice@Example.com')).toBe(credentialHash(' alice@example.com'));
    expect(credentialHash('alice@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([undefined, null, 42, ['a@b.c', 'x@y.z'], { $ne: '' }, '', '   ', 'a'.repeat(321)])(
    'maps a missing or non-string credential (%j) to the shared "none" tracker',
    (value) => {
      expect(normalizeCredential(value)).toBeUndefined();
      expect(credentialHash(value)).toBe('none');
    },
  );

  it('reads the field from an HTTP body or GraphQL args ({ input } or flat)', () => {
    expect(credentialFrom({ email: 'a@b.c' }, 'email')).toBe('a@b.c');
    expect(credentialFrom({ input: { email: 'a@b.c' } }, 'email')).toBe('a@b.c');
    expect(credentialFrom({ input: 'x' }, 'email')).toBeUndefined();
    expect(credentialFrom(undefined, 'email')).toBeUndefined();
    expect(credentialFrom('raw', 'email')).toBeUndefined();
  });
});
```

`libs/redis/src/throttler/lockout-reset.interceptor.spec.ts`:

```ts
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { markLockoutAttempt, takeLockoutAttempts } from './lockout.js';
import { LockoutResetInterceptor } from './lockout-reset.interceptor.js';

const httpContext = (req: object): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;
const gqlContext = (req: object): ExecutionContext =>
  ({
    getType: () => 'graphql',
    getArgByIndex: (i: number) => (i === 2 ? { req } : {}),
  }) as unknown as ExecutionContext;

describe('LockoutResetInterceptor', () => {
  it('resets the lockout counters of a successful credential attempt (http and graphql)', async () => {
    for (const make of [httpContext, gqlContext]) {
      const reset = vi.fn(async () => undefined);
      const interceptor = new LockoutResetInterceptor({ increment: vi.fn(), reset });
      const req = {};
      markLockoutAttempt(req, 'k1');
      const next: CallHandler = { handle: () => of('tokens') };
      await expect(lastValueFrom(interceptor.intercept(make(req), next))).resolves.toBe('tokens');
      expect(reset).toHaveBeenCalledWith('k1', 'lockout');
      expect(takeLockoutAttempts(req)).toBeUndefined();
    }
  });

  it('keeps the counter when the handler fails', async () => {
    const reset = vi.fn(async () => undefined);
    const interceptor = new LockoutResetInterceptor({ increment: vi.fn(), reset });
    const req = {};
    markLockoutAttempt(req, 'k1');
    const next: CallHandler = { handle: () => throwError(() => new Error('INVALID_CREDENTIALS')) };
    await expect(lastValueFrom(interceptor.intercept(httpContext(req), next))).rejects.toThrow();
    expect(reset).not.toHaveBeenCalled();
  });

  it('is a no-op on requests without credential attempts or storages without reset()', async () => {
    const interceptor = new LockoutResetInterceptor({ increment: vi.fn() });
    const req = {};
    markLockoutAttempt(req, 'k1');
    await expect(
      lastValueFrom(interceptor.intercept(httpContext(req), { handle: () => of(1) })),
    ).resolves.toBe(1);
    await expect(
      lastValueFrom(interceptor.intercept(httpContext({}), { handle: () => of(2) })),
    ).resolves.toBe(2);
  });

  it('never fails a successful login because the reset failed', async () => {
    const interceptor = new LockoutResetInterceptor({
      increment: vi.fn(),
      reset: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    const req = {};
    markLockoutAttempt(req, 'k1');
    await expect(
      lastValueFrom(interceptor.intercept(httpContext(req), { handle: () => of('ok') })),
    ).resolves.toBe('ok');
  });
});
```

In `libs/redis/src/throttler/app-throttler.guard.spec.ts`:

- Delete the `import { AuthThrottle } from './auth-throttle.decorator.js';` line, the two `@AuthThrottle()` methods
  and the test `'shares one "auth" bucket across every @AuthThrottle route (F17)'`.
- Delete the `Reflect.set(guard, 'limits', …)` statement in `createGuard`, and the now unused
  `import { throttleConfig } from '@platform/config';` line (Biome `noUnusedImports` is an error).
- Add `{ name: THROTTLER.AUTH, ttl: 60_000, limit: 100 }` to the `throttlers` array in `createGuard`.
- Add this policy to the `registry.register([...])` list:
  `{ name: 'id.credentials', key: 'credentials', limit: 4, ttlMs: 30_000, lockout: { threshold: 3, durationMs: 900_000 } }`.
- Add these methods to `Controller`:
  `@RateLimit('id.credentials') login(): void {}` and `@RateLimit('id.credentials') gqlLogin(): void {}`.
- Add `import { credentialHash } from './credential-tracker.util.js';` and
  `import { takeLockoutAttempts } from './lockout.js';`, and these tests:

```ts
describe('auth throttler (credentials policies)', () => {
  const credKey = (email: string, ip = 'ip:1.2.3.4') =>
    rateLimitKey('auth', 'id.credentials', `cred:${credentialHash(email)}|${ip}`);

  it('keys REST and GraphQL attempts for one account and IP into one bucket (F17)', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '1.2.3.4', body: { email: 'A@x.io ' } }),
    );
    const gql = context('graphql', { headers: {}, ip: '1.2.3.4' }, Controller.prototype.gqlLogin);
    Reflect.set(gql, 'getArgByIndex', (i: number) =>
      i === 1
        ? { input: { email: 'a@x.io' } }
        : i === 2
          ? { req: { headers: {}, ip: '1.2.3.4' }, reply: { header: vi.fn() } }
          : {},
    );
    await guard.canActivate(gql);
    const authCalls = increment.mock.calls.filter(([, , , , name]) => name === THROTTLER.AUTH);
    expect(authCalls).toEqual([
      [credKey('a@x.io'), 30_000, 4, 30_000, 'auth'],
      [credKey('a@x.io'), 30_000, 4, 30_000, 'auth'],
    ]);
  });

  it('separates accounts and IPs, and shares "none" for a missing email', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '1.2.3.4', body: { email: 'b@x.io' } }),
    );
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '5.6.7.8', body: { email: 'b@x.io' } }),
    );
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '1.2.3.4', body: { email: ['a', 'b'] } }),
    );
    const keys = increment.mock.calls.filter(([, , , , n]) => n === THROTTLER.AUTH).map(([k]) => k);
    expect(keys).toEqual([
      credKey('b@x.io'),
      credKey('b@x.io', 'ip:5.6.7.8'),
      rateLimitKey('auth', 'id.credentials', 'cred:none|ip:1.2.3.4'),
    ]);
  });

  it('counts a lockout attempt per account (any IP) and marks it for reset on success', async () => {
    const { guard, increment } = await createGuard();
    const req = { headers: {}, ip: '1.2.3.4', body: { email: 'c@x.io' } };
    await guard.canActivate(http(Controller.prototype.login, req));
    const lockoutKey = rateLimitKey(
      'lockout',
      'id.credentials',
      `acct:${credentialHash('c@x.io')}`,
    );
    expect(increment).toHaveBeenCalledWith(lockoutKey, 900_000, 3, 900_000, 'lockout');
    expect(takeLockoutAttempts(req)).toEqual([lockoutKey]);
  });

  it('a locked account answers exactly like a rate limit (429 + Retry-After), existing or not', async () => {
    const { guard, increment } = await createGuard();
    increment.mockImplementation(async (_key, _ttl, _limit, _block, name) =>
      name === 'lockout'
        ? record({ isBlocked: true, totalHits: 4, timeToBlockExpire: 900 })
        : record(),
    );
    for (const email of ['exists@x.io', 'ghost@x.io']) {
      const res = { header: vi.fn() };
      await expect(
        guard.canActivate(
          context(
            'http',
            { headers: {}, ip: '1.2.3.4', body: { email } },
            Controller.prototype.login,
            res,
          ),
        ),
      ).rejects.toBeInstanceOf(ThrottlerException);
      expect(res.header).toHaveBeenCalledWith('Retry-After', 900);
    }
  });

  it('does not lock out requests without a credential and ignores non-credential routes', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '1.2.3.4', body: {} }),
    );
    await guard.canActivate(http(Controller.prototype.list));
    expect(increment.mock.calls.map(([, , , , n]) => n)).not.toContain('lockout');
    expect(increment.mock.calls.filter(([, , , , n]) => n === 'auth')).toHaveLength(1);
  });
});
```

In `libs/redis/src/throttler/app-throttler.module.spec.ts`, delete the two lines
`// Property-injected throttle namespace (the @AuthThrottle() limits).` and
`expect(Reflect.get(guard, 'limits')).toMatchObject({ authLimit: 10, authTtlMs: 60_000 });` (the guard no longer
has `limits`).

In `libs/config/src/namespaces/namespaces.spec.ts`, replace the C1 throttle assertion with
`expect(throttleConfig.parse({})).toEqual({ ttlMs: 60_000, limit: 300 });`.

In `libs/redis/src/throttler/redis-throttler.storage.spec.ts`, add a module-level helper right after the existing
`const keys = new RedisKeyService(…);` line (C5 and C9 reuse it):

```ts
const makeStorage = () => new RedisThrottlerStorage(new InMemoryRedis().asRedis(), keys);
```

and add this `describe` at the top level of the file, after the existing `describe`:

```ts
describe('RedisThrottlerStorage.reset and the lockout boundary', () => {
  it('admits exactly THRESHOLD attempts, refuses the next one, and reset() restarts the count', async () => {
    const storage = makeStorage();
    const attempt = () => storage.increment('acct', 900_000, 3, 900_000, 'lockout');
    for (const hits of [1, 2, 3]) {
      await expect(attempt()).resolves.toMatchObject({ totalHits: hits, isBlocked: false });
    }
    await storage.reset('acct', 'lockout'); // a correct password on the 3rd attempt
    await expect(attempt()).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
    await attempt();
    await attempt();
    await expect(attempt()).resolves.toMatchObject({ isBlocked: true }); // 4th after 3 failures
  });

  it('reset() clears the hit counter of one bucket only', async () => {
    const storage = makeStorage();
    await storage.increment('k', 60_000, 5, 60_000, 'lockout');
    await storage.increment('k', 60_000, 5, 60_000, 'lockout');
    await storage.increment('other', 60_000, 5, 60_000, 'lockout');
    await storage.reset('k', 'lockout');
    await expect(storage.increment('k', 60_000, 5, 60_000, 'lockout')).resolves.toMatchObject({
      totalHits: 1,
    });
    await expect(storage.increment('other', 60_000, 5, 60_000, 'lockout')).resolves.toMatchObject({
      totalHits: 2,
    });
  });
});
```

`domains/identity/src/presentation/rate-limit/identity-rate-limit.spec.ts`:

```ts
import { RATE_LIMIT_POLICY_KEY } from '@platform/redis';
import { describe, expect, it } from 'vitest';
import { AuthResolver } from '../graphql/auth.resolver.js';
import { AuthController } from '../http/auth.controller.js';
import { IDENTITY_RATE_LIMITS, identityRateLimitPolicies } from './identity-rate-limit.js';
import { identityRateLimitConfig } from './identity-rate-limit.config.js';

describe('identity rate-limit policies', () => {
  it('declares identity.credentials from IDENTITY_* env with lockout', () => {
    expect(identityRateLimitPolicies(identityRateLimitConfig.parse({}))).toEqual([
      {
        name: 'identity.credentials',
        key: 'credentials',
        limit: 10,
        ttlMs: 60_000,
        credentialField: 'email',
        lockout: { threshold: 10, durationMs: 900_000 },
      },
    ]);
    const tuned = identityRateLimitConfig.parse({
      IDENTITY_CREDENTIALS_LIMIT: '3',
      IDENTITY_CREDENTIALS_TTL_MS: '1000',
      IDENTITY_LOCKOUT_THRESHOLD: '5',
      IDENTITY_LOCKOUT_MS: '2000',
    });
    expect(identityRateLimitPolicies(tuned)[0]).toMatchObject({
      limit: 3,
      ttlMs: 1_000,
      lockout: { threshold: 5, durationMs: 2_000 },
    });
  });

  it('every credential endpoint (REST and GraphQL) uses identity.credentials', () => {
    for (const handler of [
      AuthController.prototype.register,
      AuthController.prototype.login,
      AuthResolver.prototype.register,
      AuthResolver.prototype.login,
    ]) {
      expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler)).toBe(
        IDENTITY_RATE_LIMITS.CREDENTIALS,
      );
    }
  });
});
```

In `domains/identity/src/presentation/http/identity-http.spec.ts`:

- Replace `import { AppCacheService, AUTH_THROTTLE_KEY } from '@platform/redis';` with
  `import { AppCacheService, RATE_LIMIT_POLICY_KEY } from '@platform/redis';`.
- Replace the test at `:76-80` with:

```ts
it('credential endpoints use the identity.credentials rate-limit policy', () => {
  for (const handler of [AuthController.prototype.register, AuthController.prototype.login]) {
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler)).toBe('identity.credentials');
  }
});
```

In `libs/bootstrap/src/integration.smoke.spec.ts`:

- Import line `AuthThrottle,` → `RateLimit,`, and add `RateLimitModule,` to the same `@platform/redis` import.
- `process.env['THROTTLE_AUTH_LIMIT'] = '3';` → delete.
- On the smoke `login` handler, `@AuthThrottle()` → `@RateLimit('smoke.credentials')`.
- In `SmokeAppModule.imports`, after `AppThrottlerModule.forRootAsync(),` add:

```ts
    RateLimitModule.forFeature({
      useFactory: () => [
        { name: 'smoke.credentials', key: 'credentials', limit: 3, ttlMs: 60_000, lockout: { threshold: 50, durationMs: 60_000 } },
      ],
    }),
```

- Rename the test `'applies the @AuthThrottle window: 429 problem+json with Retry-After'` to
  `'applies the credentials policy window: 429 problem+json with Retry-After'`, and change its `hit` to
  `app.inject({ method: 'POST', url: '/v1/smoke/login', payload: { email: 'smoke@example.com' } })`.

- [ ] **Step 2: Run; expect FAIL.**
      `npx vitest run --project redis src/throttler` → FAIL (`Cannot find module './credential-tracker.util.js'` / `'./lockout.js'`).
      `npx vitest run --project identity src/presentation` → FAIL (`Cannot find module './identity-rate-limit.js'`).

- [ ] **Step 3: Implement.**

`libs/redis/src/throttler/credential-tracker.util.ts`:

```ts
import { createHash } from 'node:crypto';

/** RFC 5321 caps a mailbox at 254-320 octets; longer values are never valid identifiers. */
const MAX_CREDENTIAL_LENGTH = 320;

/** `' Alice@X.com'` → `'alice@x.com'` (NFKC, trimmed, lower-cased); non-strings → `undefined`. */
export function normalizeCredential(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_CREDENTIAL_LENGTH) return undefined;
  return normalized;
}

/**
 * sha256 of the normalised credential (no email reaches Redis). Requests without a usable
 * credential share the `'none'` tracker, so malformed bodies are still limited per IP.
 */
export function credentialHash(value: unknown): string {
  const normalized = normalizeCredential(value);
  return normalized === undefined ? 'none' : createHash('sha256').update(normalized).digest('hex');
}

/** `field` of an HTTP body, or of GraphQL args (`{ input: { email } }` or flat `{ email }`). */
export function credentialFrom(source: unknown, field: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  const direct: unknown = Reflect.get(source, field);
  if (direct !== undefined) return direct;
  const input: unknown = Reflect.get(source, 'input');
  return typeof input === 'object' && input !== null ? Reflect.get(input, field) : undefined;
}
```

`libs/redis/src/throttler/lockout.ts`:

```ts
/** Lockout buckets charged on a request, reset by `LockoutResetInterceptor` when it succeeds. */
const attempts = new WeakMap<object, Set<string>>();

export function markLockoutAttempt(request: object, key: string): void {
  const keys = attempts.get(request) ?? new Set<string>();
  keys.add(key);
  attempts.set(request, keys);
}

export function takeLockoutAttempts(request: object): string[] | undefined {
  const keys = attempts.get(request);
  attempts.delete(request);
  return keys === undefined ? undefined : [...keys];
}
```

`libs/redis/src/throttler/lockout-reset.interceptor.ts`:

```ts
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler';
import { getContextType } from '@platform/common';
import { concatMap, type Observable } from 'rxjs';
import { takeLockoutAttempts } from './lockout.js';
import { THROTTLER } from './throttle.constants.js';

interface ResettableStorage extends ThrottlerStorage {
  reset(key: string, throttlerName: string): Promise<void>;
}

const canReset = (storage: ThrottlerStorage): storage is ResettableStorage =>
  typeof Reflect.get(storage, 'reset') === 'function';

function requestOf(context: ExecutionContext): object | undefined {
  const type = getContextType(context);
  if (type === 'http') return context.switchToHttp().getRequest<object>();
  if (type === 'graphql') {
    const gql = context.getArgByIndex<{ req?: object } | undefined>(2);
    return gql?.req;
  }
  return undefined;
}

/**
 * A credential attempt counts toward the account lockout BEFORE the handler runs
 * (`AppThrottlerGuard`); this interceptor clears the count once the handler succeeded. Failed
 * logins never get here (REST fails in `LocalAuthGuard`, GraphQL throws), so the counter is
 * "attempts since the last success". A failed reset never fails the request.
 */
@Injectable()
export class LockoutResetInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LockoutResetInterceptor.name);

  constructor(@InjectThrottlerStorage() private readonly storage: ThrottlerStorage) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = requestOf(context);
    const keys = request === undefined ? undefined : takeLockoutAttempts(request);
    const storage = this.storage;
    if (keys === undefined || !canReset(storage)) return next.handle();
    return next.handle().pipe(
      concatMap(async (value: unknown) => {
        try {
          await Promise.all(keys.map((key) => storage.reset(key, THROTTLER.LOCKOUT)));
        } catch (error) {
          this.logger.warn(
            `lockout reset skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return value;
      }),
    );
  }
}
```

In `libs/redis/src/throttler/redis-throttler.storage.ts`, add after `increment(...)`:

```ts
  /** Deletes one bucket's hit counter (not its block): used to clear a lockout after a success. */
  async reset(key: string, throttlerName: string): Promise<void> {
    if (this.redis.status !== 'ready') return;
    const base = this.keys.key('throttle', hashTag(`${throttlerName}:${key}`));
    await this.redis.del(`${base}:hits`);
  }
```

In `libs/redis/src/throttler/throttle.constants.ts`, delete the `AUTH_THROTTLE_KEY` constant and its doc comment.
Delete `libs/redis/src/throttler/auth-throttle.decorator.ts`.

In `libs/redis/src/throttler/app-throttler.guard.ts`:

- `import { AUTH_THROTTLE_KEY, THROTTLER } from './throttle.constants.js';` → `import { THROTTLER } from './throttle.constants.js';`
- Delete the `@Inject(throttleConfig.KEY) private readonly limits!: ThrottleConfig;` property, its comment, the
  `@platform/config` import and `Inject` from the `@nestjs/common` import.
- Add `THROTTLER.AUTH` to the `enforced` set.
- Replace the whole `bucketFor` override and `isAuthThrottled` with:

```ts
  protected override bucketFor(
    request: ThrottlerRequest,
    subject: RateLimitSubject,
  ): RateLimitBucket | undefined {
    if ((request.throttler.name ?? THROTTLER.USER) !== THROTTLER.AUTH) {
      return super.bucketFor(request, subject);
    }
    const policy = this.policyFor(request.context);
    if (policy?.key !== 'credentials') return undefined;
    const credential = credentialHash(this.credentialOf(request.context, policy.credentialField));
    return {
      throttler: THROTTLER.AUTH,
      scope: policy.name,
      tracker: `cred:${credential}|${this.ipTracker(subject.ip)}`,
      limit: policy.limit,
      ttlMs: policy.ttlMs,
      blockMs: policy.blockMs ?? policy.ttlMs,
    };
  }

  /** After the `auth` bucket: the per-account lockout (any IP), reset on success. */
  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    await super.handleRequest(request);
    // Subclasses (IpThrottlerGuard) that don't enforce `auth` must not touch the lockout either.
    if ((request.throttler.name ?? THROTTLER.USER) !== THROTTLER.AUTH) return true;
    if (!this.enforced.has(THROTTLER.AUTH)) return true;
    if (this.isIgnored(request.context)) return true;
    const policy = this.policyFor(request.context);
    if (policy?.key !== 'credentials' || policy.lockout === undefined) return true;
    const credential = credentialHash(this.credentialOf(request.context, policy.credentialField));
    if (credential === 'none') return true;
    const bucket: RateLimitBucket = {
      throttler: THROTTLER.LOCKOUT,
      scope: policy.name,
      tracker: `acct:${credential}`,
      limit: policy.lockout.threshold,
      ttlMs: policy.lockout.durationMs,
      blockMs: policy.lockout.durationMs,
    };
    await this.charge(request.context, bucket);
    const { req } = this.getRequestResponse(request.context);
    markLockoutAttempt(req, rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker));
    return true;
  }

  /** The account identifier: HTTP body field, or GraphQL args (`input.<field>`). */
  private credentialOf(context: ExecutionContext, field = 'email'): unknown {
    if (getContextType(context) === 'graphql') {
      return credentialFrom(context.getArgByIndex<unknown>(1), field);
    }
    return credentialFrom(this.getRequestResponse(context).req['body'], field);
  }
```

- Add the imports `import { credentialFrom, credentialHash } from './credential-tracker.util.js';`,
  `import { markLockoutAttempt } from './lockout.js';` and `import { rateLimitKey } from './rate-limit-key.util.js';`.
- Update the class doc comment: "…the `route` budget of a `@RateLimit` policy and, for `credentials` policies,
  the `auth` bucket (sha256(email)+IP) plus the per-account `lockout` bucket."

In `libs/redis/src/throttler/app-throttler.module.ts`:

- Add `{ name: THROTTLER.AUTH, ttl: config.ttlMs, limit: config.limit },` after the `ROUTE` throttler entry.
- Add `LockoutResetInterceptor` to `providers` and, unconditionally, `{ provide: APP_INTERCEPTOR, useExisting: LockoutResetInterceptor }`.
- Import `APP_INTERCEPTOR` from `@nestjs/core` and `LockoutResetInterceptor` from `./lockout-reset.interceptor.js`.
- Doc bullet: `- auth: credentials policies, sha256(email)+IP, with a per-account lockout reset on success;`.

Replace `libs/config/src/namespaces/throttle.config.ts` with:

```ts
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt } from '../env/env.helpers.js';

export const throttleEnvSchema = z
  .object({
    THROTTLE_TTL_MS: zInt(60_000, { min: 1 }),
    THROTTLE_LIMIT: zInt(300, { min: 1 }),
  })
  .transform((env) => ({
    /** @nestjs/throttler 6 windows are in MILLISECONDS. Per-user (else per-IP) budget across routes. */
    ttlMs: env.THROTTLE_TTL_MS,
    limit: env.THROTTLE_LIMIT,
  }));

/** Rate limiting (Redis-backed @nestjs/throttler). Credential limits are domain policies. */
export const throttleConfig = defineConfigNamespace('throttle', throttleEnvSchema);
export type ThrottleConfig = ConfigType<typeof throttleConfig>;
```

Then `rg -n 'authTtlMs|authLimit|THROTTLE_AUTH' libs apps domains scripts` must print nothing outside docs.
Fix any remaining spec expectation the same way.

In `libs/redis/src/index.ts`:

- delete `export { AuthThrottle } from './throttler/auth-throttle.decorator.js';` and `AUTH_THROTTLE_KEY,`;
- add:

```ts
export {
  credentialFrom,
  credentialHash,
  normalizeCredential,
} from './throttler/credential-tracker.util.js';
export { LockoutResetInterceptor } from './throttler/lockout-reset.interceptor.js';
```

`domains/identity/src/presentation/rate-limit/identity-rate-limit.config.ts`:

```ts
import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const identityRateLimitEnvSchema = z
  .object({
    IDENTITY_CREDENTIALS_LIMIT: zInt(10, { min: 1 }),
    IDENTITY_CREDENTIALS_TTL_MS: zInt(60_000, { min: 1 }),
    IDENTITY_LOCKOUT_THRESHOLD: zInt(10, { min: 1 }),
    IDENTITY_LOCKOUT_MS: zInt(900_000, { min: 1 }),
  })
  .transform((env) => ({
    credentialsLimit: env.IDENTITY_CREDENTIALS_LIMIT,
    credentialsTtlMs: env.IDENTITY_CREDENTIALS_TTL_MS,
    lockoutThreshold: env.IDENTITY_LOCKOUT_THRESHOLD,
    lockoutMs: env.IDENTITY_LOCKOUT_MS,
  }));

/** Named rate-limit policies of the identity domain (gateway, monolith). */
export const identityRateLimitConfig = defineConfigNamespace(
  'identityRateLimit',
  identityRateLimitEnvSchema,
);
export type IdentityRateLimitConfig = ConfigType<typeof identityRateLimitConfig>;
```

`domains/identity/src/presentation/rate-limit/identity-rate-limit.ts`:

```ts
import { ConfigModule } from '@nestjs/config';
import { RateLimitModule, type RateLimitPolicy } from '@platform/redis';
import {
  type IdentityRateLimitConfig,
  identityRateLimitConfig,
} from './identity-rate-limit.config.js';

export const IDENTITY_RATE_LIMITS = { CREDENTIALS: 'identity.credentials' } as const;

/** Register and login (REST + GraphQL): per sha256(email)+IP, plus a per-account lockout. */
export function identityRateLimitPolicies(cfg: IdentityRateLimitConfig): RateLimitPolicy[] {
  return [
    {
      name: IDENTITY_RATE_LIMITS.CREDENTIALS,
      key: 'credentials',
      limit: cfg.credentialsLimit,
      ttlMs: cfg.credentialsTtlMs,
      credentialField: 'email',
      lockout: { threshold: cfg.lockoutThreshold, durationMs: cfg.lockoutMs },
    },
  ];
}

export const IdentityRateLimitModule = RateLimitModule.forFeature({
  imports: [ConfigModule.forFeature(identityRateLimitConfig)],
  inject: [identityRateLimitConfig.KEY],
  useFactory: identityRateLimitPolicies,
});
```

In `domains/identity/src/identity-api.module.ts`:

- add `import { IdentityRateLimitModule } from './presentation/rate-limit/identity-rate-limit.js';`;
- `imports: [IdentityCoreModule, GraphqlLoadersModule],` → `imports: [IdentityCoreModule, GraphqlLoadersModule, IdentityRateLimitModule],`;
- `imports: [GrpcClientsModule.register(target, options), GraphqlLoadersModule],` →
  `imports: [GrpcClientsModule.register(target, options), GraphqlLoadersModule, IdentityRateLimitModule],`;
- if G plan Task 2 already changed these arrays (`forLocal()` no longer imports `IdentityCoreModule`), append
  `IdentityRateLimitModule` as the last element of both `imports:` arrays as they stand;
- in the doc comment at `:43`, `` `AppThrottlerModule` (`@AuthThrottle`) `` → `` `AppThrottlerModule` (`@RateLimit` policies) ``.

Export the namespace: if `domains/identity/src/api/index.ts` exists (G plan Task 2 merged first), add
`export { identityRateLimitConfig, type IdentityRateLimitConfig } from '../presentation/rate-limit/identity-rate-limit.config.js';`
there (presentation config loaded by `IdentityApiModule`, like `identityGrpcClientConfig`; the root re-exports
`./api`). Otherwise add
`export { identityRateLimitConfig, type IdentityRateLimitConfig } from './presentation/rate-limit/identity-rate-limit.config.js';`
to `domains/identity/src/index.ts`.

In `domains/identity/src/presentation/http/auth.controller.ts`:

- `import { AuthThrottle } from '@platform/redis';` → `import { RateLimit } from '@platform/redis';`
- add `import { IDENTITY_RATE_LIMITS } from '../rate-limit/identity-rate-limit.js';`
- both `@AuthThrottle()` → `@RateLimit(IDENTITY_RATE_LIMITS.CREDENTIALS)`.

In `domains/identity/src/presentation/graphql/auth.resolver.ts`, make the same import and decorator swap. Doc line
``* `@AuthThrottle` applies because the throttler guard throttles GraphQL too.`` becomes
``* `identity.credentials` (shared with REST) applies because the throttler guard throttles GraphQL too.``

In both apps' `test/env-example.spec.ts`, import `identityRateLimitConfig` (gateway: in the import statement that
brings in `identityGrpcClientConfig`, `'@domain/identity'` or `'@domain/identity/api'` after G; monolith: add it to
the existing `passwordConfig, refreshTokenConfig` import from `'@domain/identity'`) and append it to `NAMESPACES`.

In the root `.env.example`, replace the throttle section lines

```
# Stricter window for login/register (brute-force protection)
# THROTTLE_AUTH_TTL_MS=60000
# THROTTLE_AUTH_LIMIT=10
```

with nothing, and add after the notifications block from C1:

```
# ── identityRateLimit: credential endpoints, register + login REST and GraphQL (gateway, monolith) ──
# identity.credentials: attempts per sha256(email)+client IP per window (replaces THROTTLE_AUTH_*).
# IDENTITY_CREDENTIALS_LIMIT=10
# IDENTITY_CREDENTIALS_TTL_MS=60000
# Lockout: after this many failed attempts per account (any IP) within one IDENTITY_LOCKOUT_MS window, the next
# ones are refused (429) for IDENTITY_LOCKOUT_MS. A success before that resets the count.
# IDENTITY_LOCKOUT_THRESHOLD=10
# IDENTITY_LOCKOUT_MS=900000
```

- [ ] **Step 4: Run; expect PASS.**
      `npx vitest run --project redis --project identity --project config --project bootstrap`. Expected: PASS.

- [ ] **Step 5: Wider checks.**
      `npx biome check --write libs/redis/src libs/config/src libs/bootstrap/src domains/identity/src apps/gateway/test apps/monolith/test`,
      then `npx vitest run --project gateway --project monolith`, `node scripts/check-env-example.mjs`, `bun run check`,
      and `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off). Expected: PASS.
      Before running them, add `IDENTITY_CREDENTIALS_LIMIT: '100000',` and `IDENTITY_LOCKOUT_THRESHOLD: '100000',` to
      `MONOLITH_E2E_ENV` and `GATEWAY_E2E_ENV` (`apps/*/test/support/e2e-env.ts`), so the existing auth flows, which log
      in repeatedly with wrong passwords, are never locked. C7's specs override these values.

- [ ] **Step 6: Commit.**

```bash
git add libs/redis libs/config/src/namespaces libs/bootstrap/src/integration.smoke.spec.ts domains/identity/src apps/gateway/test apps/monolith/test .env.example bun.lock
git commit -m "feat(redis,identity,config): limit credentials by sha256(email) and IP with account lockout" \
  -m "identity.credentials (IDENTITY_CREDENTIALS_*, IDENTITY_LOCKOUT_*) replaces @AuthThrottle and THROTTLE_AUTH_*. The auth bucket is shared by REST and GraphQL; attempts count toward a per-account lockout that a successful handler resets."
```

### Task C3: Pre-auth `ip` throttler and proxy-aware WebSocket client IPs (C-2, except the tenant part)

**Wave:** 1, after C2, in lane `c-throttle`.

**Why:**

- Spec §11 asks for a generous per-IP cap that runs before JWT parsing, so 401/403 floods are counted. Today the
  only throttler is registered after `AuthModule` (`apps/gateway/src/app.module.ts:50-52`,
  `apps/monolith/src/app.module.ts:75-77`), so a request with a bad token is rejected by `JwtAuthGuard` before any
  limit applies.
- WebSocket trackers use the raw `handshake.address` (`ws-throttler.guard.ts:45`). Behind a load balancer, every
  client then shares the LB's bucket.

Nest runs `APP_GUARD`s in module-scan order, so the new guard lives in its own `IpThrottlerModule`, imported
before `AuthModule`. Its options and storage come from the `@Global` ThrottlerModule inside `AppThrottlerModule`.

**Files:**

- Create: `libs/redis/src/throttler/ip-throttler.guard.ts`, `libs/redis/src/throttler/ip-throttler.guard.spec.ts`
- Create: `libs/redis/src/throttler/client-ip.util.ts`, `libs/redis/src/throttler/client-ip.util.spec.ts`
- Modify: `libs/redis/src/throttler/ws-throttler.guard.ts`, `libs/redis/src/throttler/ws-throttler.guard.spec.ts`,
  `libs/redis/src/throttler/app-throttler.module.ts`, `libs/redis/src/index.ts`, `libs/redis/package.json`
- Modify: `libs/config/src/namespaces/throttle.config.ts`, `libs/config/src/namespaces/namespaces.spec.ts`
- Create: `libs/bootstrap/src/rate-limit-order.spec.ts`
- Modify: `apps/gateway/src/app.module.ts`, `apps/monolith/src/app.module.ts`, root `package.json` (catalog), root `.env.example`

**Interfaces:**

- Consumes: `AppThrottlerGuard` (C2), `AppConfig.trustProxy: boolean | string[]` (`libs/config/src/namespaces/app.config.ts:66`),
  `proxyaddr(req, trust)` / `proxyaddr.compile(list)` from `@fastify/proxy-addr` 5.1.1.
- Produces:

  ```ts
  export class IpThrottlerGuard extends AppThrottlerGuard {} // enforces only 'ip'
  export class IpThrottlerModule {} // APP_GUARD; import BEFORE AuthModule
  export type ClientIpResolver = (request: IncomingMessage | undefined) => string | undefined;
  export function createClientIpResolver(trustProxy: boolean | string[]): ClientIpResolver;
  // ThrottleConfig gains: ipTtlMs (THROTTLE_IP_TTL_MS, 60000), ipLimit (THROTTLE_IP_LIMIT, 600)
  ```

- [ ] **Step 1: Add the dependency (controller runs the install).**
      In the root `package.json` `catalog`, add `"@fastify/proxy-addr": "5.1.1",` in alphabetical order, after
      `"@fastify/multipart"`. 5.1.1 is the copy Fastify already hoists into `node_modules/@fastify/proxy-addr`; 5.1.2 is
      the latest. In `libs/redis/package.json` `dependencies`, add `"@fastify/proxy-addr": "catalog:",` before `"@keyv/redis"`.
      Ask the controller to run `bun install` and to stage `bun.lock`. The tests below run before that, because the
      package is already in `node_modules`.

- [ ] **Step 2: Write the failing tests.**

`libs/redis/src/throttler/client-ip.util.spec.ts`:

```ts
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createClientIpResolver } from './client-ip.util.js';

const request = (remoteAddress: string, forwardedFor?: string): IncomingMessage =>
  ({
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  }) as unknown as IncomingMessage;

describe('createClientIpResolver', () => {
  it('TRUST_PROXY=false ignores X-Forwarded-For (no spoofing)', () => {
    expect(createClientIpResolver(false)(request('10.0.0.5', '1.2.3.4'))).toBe('10.0.0.5');
  });

  it('a trusted CIDR only honours the hop the proxy appended', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8']);
    expect(resolve(request('10.0.0.5', '6.6.6.6, 1.2.3.4'))).toBe('1.2.3.4');
    expect(resolve(request('8.8.8.8', '1.2.3.4'))).toBe('8.8.8.8'); // untrusted peer
  });

  it('accepts the proxy-addr presets', () => {
    expect(createClientIpResolver(['loopback'])(request('127.0.0.1', '1.2.3.4'))).toBe('1.2.3.4');
  });

  it('TRUST_PROXY=true takes the leftmost address', () => {
    expect(createClientIpResolver(true)(request('10.0.0.5', '1.2.3.4, 10.0.0.9'))).toBe('1.2.3.4');
  });

  it('returns undefined without a request or socket address', () => {
    const resolve = createClientIpResolver(false);
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve({ socket: {}, headers: {} } as unknown as IncomingMessage)).toBeUndefined();
  });

  it('treats an empty list as "trust nobody"', () => {
    expect(createClientIpResolver([])(request('10.0.0.5', '1.2.3.4'))).toBe('10.0.0.5');
  });
});
```

`libs/redis/src/throttler/ip-throttler.guard.spec.ts`:

```ts
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { IpThrottlerGuard } from './ip-throttler.guard.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { THROTTLER } from './throttle.constants.js';

class Controller {
  handle(): void {}
}

const context = (type: string, req: Record<string, unknown>): ExecutionContext =>
  ({
    getType: () => type,
    getHandler: () => Controller.prototype.handle,
    getClass: () => Controller,
    getArgByIndex: (i: number) => (i === 2 ? { req, reply: { header: vi.fn() } } : {}),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: vi.fn() }) }),
  }) as unknown as ExecutionContext;

async function createGuard() {
  const increment = vi.fn<ThrottlerStorage['increment']>(async () => ({
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: false,
    timeToBlockExpire: 0,
  }));
  const guard = new IpThrottlerGuard(
    {
      throttlers: [
        { name: THROTTLER.IP, ttl: 60_000, limit: 600 },
        { name: THROTTLER.USER, ttl: 60_000, limit: 100 },
        { name: THROTTLER.ROUTE, ttl: 60_000, limit: 100 },
        { name: THROTTLER.AUTH, ttl: 60_000, limit: 100 },
      ],
    },
    { increment },
    new Reflector(),
  );
  Reflect.set(guard, 'policies', new RateLimitPolicyRegistry());
  await guard.onModuleInit();
  return { guard, increment };
}

describe('IpThrottlerGuard', () => {
  it('charges only the ip budget, keyed by client IP even when a user is present', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(context('http', { headers: {}, ip: '1.2.3.4', user: { id: 'u-1' } }));
    expect(increment.mock.calls).toEqual([
      [rateLimitKey('ip', 'global', 'ip:1.2.3.4'), 60_000, 600, 60_000, 'ip'],
    ]);
  });

  it('runs for graphql and skips ws and rpc', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(context('graphql', { headers: {}, ip: '1.2.3.4' }));
    await guard.canActivate(context('ws', {}));
    await guard.canActivate(context('rpc', {}));
    expect(increment).toHaveBeenCalledTimes(1);
  });
});
```

In `libs/redis/src/throttler/ws-throttler.guard.spec.ts`, add:

```ts
it('keys anonymous sockets by the proxy-aware client IP of the handshake request', async () => {
  const { guard, increment } = await createGuard();
  Reflect.set(guard, 'app', { trustProxy: ['10.0.0.0/8'] });
  const socket = {
    data: {},
    handshake: { address: '10.0.0.5' },
    request: {
      socket: { remoteAddress: '10.0.0.5' },
      headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' },
    },
  };
  await guard.canActivate(wsContext(socket));
  expect(increment.mock.calls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'ip:1.2.3.4'));
});

it('ignores X-Forwarded-For when no proxy is trusted (default)', async () => {
  const { guard, increment } = await createGuard();
  const socket = {
    data: {},
    handshake: { address: '10.0.0.5' },
    request: { socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } },
  };
  await guard.canActivate(wsContext(socket));
  expect(increment.mock.calls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'ip:10.0.0.5'));
});
```

`libs/bootstrap/src/rate-limit-order.spec.ts`:

```ts
import { Controller, Get, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthModule } from '@platform/auth';
import { Public } from '@platform/common';
import { AppConfigModule, appConfig } from '@platform/config';
import { ObservabilityModule } from '@platform/observability';
import { AppThrottlerModule, IpThrottlerModule, REDIS_CLIENT, RedisModule } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { createFastifyTestApp } from '@platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFastifyOptions, configureHttpApp } from './index.js';

process.env['LOG_LEVEL'] = 'silent';
process.env['THROTTLE_IP_LIMIT'] = '3';

@Controller('order')
class OrderController {
  @Get('private')
  privateRoute(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('public')
  publicRoute(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ observe: false }),
    RedisModule.forRootAsync(),
    IpThrottlerModule, // BEFORE AuthModule: counts requests JwtAuthGuard rejects
    AuthModule.forRootAsync({ globalGuards: true }),
    AppThrottlerModule.forRootAsync(),
  ],
  controllers: [OrderController],
})
class OrderAppModule {}

describe('guard order: the ip throttler runs before authentication', () => {
  const redis = new InMemoryRedis();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const config = appConfig.parse();
    const builder = Test.createTestingModule({ imports: [OrderAppModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis.asRedis());
    app = await createFastifyTestApp(
      builder,
      (created) =>
        configureHttpApp(created, { config, shutdownHooks: false, processHandlers: false }),
      {
        adapter: new FastifyAdapter(buildFastifyOptions(config)),
        appOptions: { bufferLogs: true },
      },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('counts 401s: the 4th unauthenticated request from one IP is 429, not 401', async () => {
    const hit = () =>
      app.inject({
        method: 'GET',
        url: '/v1/order/private',
        headers: { authorization: 'Bearer nope' },
      });
    for (let i = 0; i < 3; i += 1) expect((await hit()).statusCode).toBe(401);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    // Same IP, public route: the ip budget is global across routes.
    expect((await app.inject({ method: 'GET', url: '/v1/order/public' })).statusCode).toBe(429);
    // Ops paths stay exempt.
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});
```

Before writing it, confirm with `jaq '.dependencies, .devDependencies' libs/bootstrap/package.json` that
`@platform/auth`, `@platform/redis`, `@platform/observability` and `@platform/testing` are declared, the same way
`integration.smoke.spec.ts` uses them. Add any that are missing to `devDependencies` as `"workspace:*"`.

In `libs/config/src/namespaces/namespaces.spec.ts`, replace the throttle assertion (C1/C2) with:

```ts
expect(throttleConfig.parse({})).toEqual({
  ttlMs: 60_000,
  limit: 300,
  ipTtlMs: 60_000,
  ipLimit: 600,
});
```

- [ ] **Step 3: Run; expect FAIL.**
      `npx vitest run --project redis src/throttler` and `npx vitest run --project config src/namespaces`.
      Expected: FAIL (`Cannot find module './client-ip.util.js'`, `'./ip-throttler.guard.js'`; `ipLimit` missing).
      `npx vitest run --project bootstrap src/rate-limit-order.spec.ts`: Expected: FAIL (`IpThrottlerModule` is not exported).

- [ ] **Step 4: Implement.**

`libs/redis/src/throttler/client-ip.util.ts`:

```ts
import type { IncomingMessage } from 'node:http';
import proxyAddr from '@fastify/proxy-addr';

export type ClientIpResolver = (request: IncomingMessage | undefined) => string | undefined;

/**
 * The client IP of a raw Node request (Socket.IO `socket.request`, graphql-ws `ctx.extra.request`)
 * with the SAME trust rules Fastify applies to `req.ip` (`TRUST_PROXY`): `false` → socket
 * address; a list of IPs/CIDRs/presets → the first untrusted hop from the right; `true` → the
 * leftmost `X-Forwarded-For` value (spoofable; rejected in production by the app namespace).
 */
export function createClientIpResolver(trustProxy: boolean | string[]): ClientIpResolver {
  const trust =
    trustProxy === true
      ? (): boolean => true
      : trustProxy === false || trustProxy.length === 0
        ? (): boolean => false
        : proxyAddr.compile(trustProxy);
  return (request) => {
    const socketAddress = request?.socket?.remoteAddress;
    if (request === undefined || socketAddress === undefined) return undefined;
    try {
      return proxyAddr(request, trust);
    } catch {
      return socketAddress;
    }
  };
}
```

`libs/redis/src/throttler/ip-throttler.guard.ts`:

```ts
import { Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { THROTTLER } from './throttle.constants.js';

/**
 * The generous pre-authentication flood cap (`THROTTLE_IP_LIMIT` per `THROTTLE_IP_TTL_MS`, keyed by
 * client IP, scope `global`) for HTTP and GraphQL. It must run BEFORE `JwtAuthGuard`, so requests
 * that authentication rejects (401/403 floods) are still counted: see `IpThrottlerModule`.
 */
@Injectable()
export class IpThrottlerGuard extends AppThrottlerGuard {
  protected override readonly enforced: ReadonlySet<string> = new Set<string>([THROTTLER.IP]);
}

/**
 * Registers `IpThrottlerGuard` as a global guard. Global guards run in module-scan order, so
 * import this module BEFORE `AuthModule`; `AppThrottlerModule` (anywhere) provides the options,
 * storage and policy registry.
 */
@Module({
  providers: [IpThrottlerGuard, { provide: APP_GUARD, useExisting: IpThrottlerGuard }],
})
export class IpThrottlerModule {}
```

In `libs/redis/src/throttler/ws-throttler.guard.ts`:

- Add the imports `import type { IncomingMessage } from 'node:http';`, `Inject, Optional` from `@nestjs/common`,
  `import { type AppConfig, appConfig } from '@platform/config';` and
  `import { type ClientIpResolver, createClientIpResolver } from './client-ip.util.js';`.
- `SocketLike` gains `request?: IncomingMessage;`.
- Add to the class:

```ts
  @Optional()
  @Inject(appConfig.KEY)
  private readonly app?: AppConfig;

  private resolver: ClientIpResolver | undefined;

  private clientIp(client: SocketLike | undefined): string | undefined {
    this.resolver ??= createClientIpResolver(this.app?.trustProxy ?? false);
    return this.resolver(client?.request) ?? client?.handshake?.address;
  }
```

- In `subjectOf`, `ip: client?.handshake?.address` → `ip: this.clientIp(client)`.
- Doc comment: add "IP = the handshake request's client IP under `TRUST_PROXY` (same rules as HTTP `req.ip`)".

In `libs/redis/src/throttler/app-throttler.module.ts`, add `{ name: THROTTLER.IP, ttl: config.ipTtlMs, limit: config.ipLimit },`
as the first `throttlers` entry. Add this doc bullet:
`- ip: THROTTLE_IP_LIMIT per THROTTLE_IP_TTL_MS per client IP, charged by IpThrottlerGuard (import IpThrottlerModule BEFORE AuthModule);`

In `libs/config/src/namespaces/throttle.config.ts`, add to the object `THROTTLE_IP_TTL_MS: zInt(60_000, { min: 1 }),`
and `THROTTLE_IP_LIMIT: zInt(600, { min: 1 }),`. Add to the transform:

```ts
    /** Pre-auth flood cap per client IP (all routes), counted before JWT verification. */
    ipTtlMs: env.THROTTLE_IP_TTL_MS,
    ipLimit: env.THROTTLE_IP_LIMIT,
```

In `libs/redis/src/index.ts`, add:

```ts
export { type ClientIpResolver, createClientIpResolver } from './throttler/client-ip.util.js';
export { IpThrottlerGuard, IpThrottlerModule } from './throttler/ip-throttler.guard.js';
```

In `apps/gateway/src/app.module.ts`:

- add `IpThrottlerModule,` to the `@platform/redis` import list;
- replace

```ts
    // Edge security: JWT + RBAC guards, then the Redis-backed throttler.
    AuthModule.forRootAsync(),
```

with

```ts
    // Edge security: the pre-auth per-IP cap (counts 401/403 floods), JWT + RBAC guards, then the
    // per-user / per-route / credential throttler.
    IpThrottlerModule,
    AuthModule.forRootAsync(),
```

- In the class doc comment, `→ AuthModule BEFORE AppThrottlerModule` becomes
  `→ IpThrottlerModule BEFORE AuthModule BEFORE AppThrottlerModule`.

Make the same import-list and module-list edits in `apps/monolith/src/app.module.ts` (`:75-77`). Its doc comment
words the order differently, so replace these lines (`:47-50`) exactly:

```ts
 * config → observability (logger, cls, health) → infrastructure → AuthModule BEFORE
 * AppThrottlerModule (global guards run in registration order: the throttler must see `req.user`
 * to track per user, and `@AuthThrottle` handlers) → GraphQL → domain modules (their `Api`
```

with

```ts
 * config → observability (logger, cls, health) → infrastructure → IpThrottlerModule BEFORE
 * AuthModule BEFORE AppThrottlerModule (global guards run in registration order: the ip cap must
 * count requests JWT rejects, the per-user throttler must see `req.user`) → GraphQL → domain
 * modules (their `Api`
```

(C7's `rg 'AuthThrottle'` check would otherwise still find this comment.)

In the root `.env.example` throttle section, after `# THROTTLE_LIMIT=300`, add:

```
# Pre-auth flood cap per client IP across all routes, counted before the token is checked.
# THROTTLE_IP_TTL_MS=60000
# THROTTLE_IP_LIMIT=600
```

- [ ] **Step 5: Run; expect PASS.**
      `npx vitest run --project redis --project config` and `npx vitest run --project bootstrap`. Expected: PASS.

- [ ] **Step 6: Wider checks.**
      `npx biome check --write libs/redis libs/config/src libs/bootstrap/src apps/gateway/src apps/monolith/src package.json`,
      then `bun run check`, `node scripts/check-env-example.mjs`, and
      `npx vitest run --project gateway --project monolith --project gateway:e2e --project monolith:e2e` (sandbox off).
      Expected: PASS. e2e apps inject from 127.0.0.1, so the ip cap is shared by a whole spec file. Before running, add
      `THROTTLE_IP_LIMIT: '100000',` to `MONOLITH_E2E_ENV` and `GATEWAY_E2E_ENV` (`apps/*/test/support/e2e-env.ts`); C7's
      specs override it.

- [ ] **Step 7: Commit (after the controller's `bun install`).**

```bash
git add libs/redis libs/config/src libs/bootstrap/src/rate-limit-order.spec.ts apps/gateway/src/app.module.ts apps/monolith/src/app.module.ts apps/gateway/test/support/e2e-env.ts apps/monolith/test/support/e2e-env.ts package.json bun.lock .env.example
git commit -m "feat(redis,gateway,monolith): add the pre-auth ip throttler and proxy-aware ws client ips" \
  -m "IpThrottlerModule is imported before AuthModule so 401/403 floods are counted (THROTTLE_IP_*). WsThrottlerGuard resolves the client IP of the handshake request with TRUST_PROXY rules via @fastify/proxy-addr 5.1.1."
```

### Task C4: IETF `RateLimit-Policy` / `RateLimit` headers, also on 429, exposed through CORS (C-7)

**Wave:** 1, after C3, in lane `c-throttle`.

**Why:**

- Spec §11 asks for IETF `RateLimit-Policy` and `RateLimit` plus `Retry-After`, also on 429s, and exposed through
  CORS.
- Since C1 our guards no longer emit `X-RateLimit-*`. Before C1 they were set only on non-blocked responses
  (`throttler.guard.js:128-147`), and with several budgets each `res.header()` overwrote the last.

This task implements draft-ietf-httpapi-ratelimit-headers-11 (2026-05-23, Structured Field Lists):

- `RateLimit-Policy: "<name>";q=<quota>;w=<window s>`
- `RateLimit: "<name>";r=<remaining>;t=<reset s>`

Every budget charged on the request is listed:

- the name is the throttler for global scopes (`"ip"`, `"user"`, `"tenant"`), or `<throttler>:<policy>`
  (`"route:files.upload"`, `"auth:identity.credentials"`);
- decisions are collected per response across both guards, de-duplicated by name (last wins), and listed in a
  fixed order;
- the `lockout` bucket is never advertised (it would publish a per-account counter).

**Files:**

- Create: `libs/redis/src/throttler/rate-limit-headers.ts`, `libs/redis/src/throttler/rate-limit-headers.spec.ts`
- Modify: `libs/redis/src/throttler/rate-limit-guard.base.ts`, `libs/redis/src/throttler/app-throttler.guard.spec.ts`,
  `libs/redis/src/index.ts`
- Modify: `libs/common/src/constants/headers.constants.ts`, `libs/bootstrap/src/http/create-http-app.ts` (`:96-100`),
  `libs/bootstrap/src/rate-limit-order.spec.ts`

**Interfaces:**

- Consumes: `RateLimitGuardBase.charge` and `responseOf` (C1), `ThrottlerStorageRecord`.
- Produces:

  ```ts
  export interface RateLimitDecision {
    throttler: string;
    scope: string;
    limit: number;
    ttlMs: number;
    remaining: number;
    resetSeconds: number;
    blocked: boolean;
    retryAfterSeconds: number;
  }
  export const RATE_LIMIT_HEADER_ORDER: readonly string[]; // ['ip','user','tenant','route','auth']
  export function policyItemName(decision: Pick<RateLimitDecision, 'throttler' | 'scope'>): string;
  export function formatRateLimitPolicy(decisions: readonly RateLimitDecision[]): string;
  export function formatRateLimit(decisions: readonly RateLimitDecision[]): string;
  export function collectDecision(
    response: object,
    decision: RateLimitDecision,
  ): RateLimitDecision[];
  // RateLimitGuardBase: protected recordDecision(context: ExecutionContext, decision: RateLimitDecision): void  ← G-10 hook
  // HTTP_HEADERS.RATE_LIMIT_POLICY = 'ratelimit-policy', HTTP_HEADERS.RATE_LIMIT = 'ratelimit'
  ```

- [ ] **Step 1: Write the failing tests.**

`libs/redis/src/throttler/rate-limit-headers.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  collectDecision,
  formatRateLimit,
  formatRateLimitPolicy,
  policyItemName,
  type RateLimitDecision,
} from './rate-limit-headers.js';

const decision = (overrides: Partial<RateLimitDecision>): RateLimitDecision => ({
  throttler: 'user',
  scope: 'global',
  limit: 100,
  ttlMs: 60_000,
  remaining: 99,
  resetSeconds: 60,
  blocked: false,
  retryAfterSeconds: 0,
  ...overrides,
});

describe('IETF RateLimit headers (draft-ietf-httpapi-ratelimit-headers-11)', () => {
  it('names global budgets by throttler and policy budgets by throttler:policy', () => {
    expect(policyItemName({ throttler: 'ip', scope: 'global' })).toBe('ip');
    expect(policyItemName({ throttler: 'route', scope: 'files.upload' })).toBe(
      'route:files.upload',
    );
  });

  it('formats RateLimit-Policy (q, w in whole seconds, at least 1)', () => {
    expect(
      formatRateLimitPolicy([
        decision({ throttler: 'ip', limit: 600 }),
        decision({ throttler: 'route', scope: 'files.upload', limit: 3, ttlMs: 10_500 }),
        decision({ throttler: 'auth', scope: 'x.y', ttlMs: 10 }),
      ]),
    ).toBe('"ip";q=600;w=60, "route:files.upload";q=3;w=11, "auth:x.y";q=100;w=1');
  });

  it('formats RateLimit (r, t)', () => {
    expect(formatRateLimit([decision({ remaining: 0, resetSeconds: 42 })])).toBe('"user";r=0;t=42');
  });

  it('collects decisions per response, last one per name wins, fixed order', () => {
    const res = {};
    collectDecision(res, decision({ throttler: 'route', scope: 'a.b', remaining: 5 }));
    collectDecision(res, decision({ throttler: 'user', remaining: 9 }));
    collectDecision(res, decision({ throttler: 'ip', remaining: 7 }));
    const all = collectDecision(res, decision({ throttler: 'route', scope: 'a.b', remaining: 4 }));
    expect(all.map((d) => [policyItemName(d), d.remaining])).toEqual([
      ['ip', 7],
      ['user', 9],
      ['route:a.b', 4],
    ]);
    expect(collectDecision({}, decision({}))).toHaveLength(1);
  });
});
```

In `libs/redis/src/throttler/app-throttler.guard.spec.ts`, add:

```ts
it('sets RateLimit-Policy and RateLimit for every charged budget, and on 429 too', async () => {
  const { guard, increment } = await createGuard();
  increment.mockImplementation(async (_k, _t, _l, _b, name) =>
    name === 'route'
      ? record({ totalHits: 3, timeToExpire: 8 })
      : record({ totalHits: 10, timeToExpire: 50 }),
  );
  const res = { header: vi.fn() };
  await guard.canActivate(
    context('http', { headers: {}, user: { id: 'u-1' } }, Controller.prototype.upload, res),
  );
  expect(res.header).toHaveBeenLastCalledWith(
    'RateLimit',
    '"user";r=90;t=50, "route:files.upload";r=0;t=8',
  );
  expect(res.header).toHaveBeenCalledWith(
    'RateLimit-Policy',
    '"user";q=100;w=60, "route:files.upload";q=3;w=10',
  );

  const blockedRes = { header: vi.fn() };
  increment.mockResolvedValue(record({ isBlocked: true, totalHits: 101, timeToBlockExpire: 30 }));
  await expect(
    guard.canActivate(
      context('http', { headers: {}, ip: '1.2.3.4' }, Controller.prototype.list, blockedRes),
    ),
  ).rejects.toBeInstanceOf(ThrottlerException);
  expect(blockedRes.header).toHaveBeenCalledWith('RateLimit', '"user";r=0;t=30');
  expect(blockedRes.header).toHaveBeenCalledWith('Retry-After', 30);
});

it('never advertises the lockout bucket', async () => {
  const { guard } = await createGuard();
  const res = { header: vi.fn() };
  await guard.canActivate(
    context(
      'http',
      { headers: {}, ip: '1.2.3.4', body: { email: 'a@x.io' } },
      Controller.prototype.login,
      res,
    ),
  );
  const values = res.header.mock.calls.map(([, value]) => String(value)).join(' ');
  expect(values).toContain('"auth:id.credentials"');
  expect(values).not.toContain('lockout');
});
```

In `libs/bootstrap/src/rate-limit-order.spec.ts`, add as the FIRST test of the `describe` block:

```ts
it('sends the IETF headers and exposes them (and Retry-After) through CORS', async () => {
  await redis.flushall();
  const response = await app.inject({
    method: 'GET',
    url: '/v1/order/public',
    headers: { origin: 'http://localhost:3000' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['ratelimit-policy']).toBe('"ip";q=3;w=60, "user";q=300;w=60');
  expect(response.headers['ratelimit']).toBe('"ip";r=2;t=60, "user";r=299;t=60');
  const exposed = String(response.headers['access-control-expose-headers']).toLowerCase();
  for (const name of ['ratelimit-policy', 'ratelimit', 'retry-after'])
    expect(exposed).toContain(name);
  expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  await redis.flushall();
});
```

- [ ] **Step 2: Run; expect FAIL.**
      `npx vitest run --project redis src/throttler` → FAIL (`Cannot find module './rate-limit-headers.js'`).
      `npx vitest run --project bootstrap src/rate-limit-order.spec.ts` → FAIL (`ratelimit-policy` header undefined).

- [ ] **Step 3: Implement.**

`libs/redis/src/throttler/rate-limit-headers.ts`:

```ts
import { GLOBAL_SCOPE } from './throttle.constants.js';

/** One budget's outcome for one request (headers here; decision metrics in G-10). */
export interface RateLimitDecision {
  throttler: string;
  scope: string;
  limit: number;
  ttlMs: number;
  remaining: number;
  resetSeconds: number;
  blocked: boolean;
  retryAfterSeconds: number;
}

/** Display order of the list members (unknown names sort last, alphabetically). */
export const RATE_LIMIT_HEADER_ORDER: readonly string[] = Object.freeze([
  'ip',
  'user',
  'tenant',
  'route',
  'auth',
]);

export function policyItemName(decision: Pick<RateLimitDecision, 'throttler' | 'scope'>): string {
  return decision.scope === GLOBAL_SCOPE
    ? decision.throttler
    : `${decision.throttler}:${decision.scope}`;
}

/** RFC 9651 sf-string (policy names are ASCII by construction; escape anyway). */
const sfString = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const windowSeconds = (ttlMs: number): number => Math.max(1, Math.ceil(ttlMs / 1_000));

/** `RateLimit-Policy: "user";q=100;w=60, …` (draft-ietf-httpapi-ratelimit-headers-11 §3). */
export function formatRateLimitPolicy(decisions: readonly RateLimitDecision[]): string {
  return decisions
    .map((d) => `${sfString(policyItemName(d))};q=${d.limit};w=${windowSeconds(d.ttlMs)}`)
    .join(', ');
}

/** `RateLimit: "user";r=99;t=60, …` (draft-ietf-httpapi-ratelimit-headers-11 §4). */
export function formatRateLimit(decisions: readonly RateLimitDecision[]): string {
  return decisions
    .map((d) => `${sfString(policyItemName(d))};r=${d.remaining};t=${d.resetSeconds}`)
    .join(', ');
}

const rank = (d: RateLimitDecision): number => {
  const index = RATE_LIMIT_HEADER_ORDER.indexOf(d.throttler);
  return index === -1 ? RATE_LIMIT_HEADER_ORDER.length : index;
};

const collected = new WeakMap<object, Map<string, RateLimitDecision>>();

/** Adds `decision` to the response's set (both guards share it) and returns the ordered list. */
export function collectDecision(
  response: object,
  decision: RateLimitDecision,
): RateLimitDecision[] {
  const byName = collected.get(response) ?? new Map<string, RateLimitDecision>();
  byName.set(policyItemName(decision), decision);
  collected.set(response, byName);
  return [...byName.values()].sort(
    (a, b) => rank(a) - rank(b) || policyItemName(a).localeCompare(policyItemName(b)),
  );
}
```

In `libs/redis/src/throttler/rate-limit-guard.base.ts`:

- Add the imports
  `import { collectDecision, formatRateLimit, formatRateLimitPolicy, type RateLimitDecision } from './rate-limit-headers.js';`.
- Replace the body of `charge` with:

```ts
const key = rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker);
const record = await this.storageService.increment(
  key,
  bucket.ttlMs,
  bucket.limit,
  bucket.blockMs,
  bucket.throttler,
);
this.recordDecision(context, {
  throttler: bucket.throttler,
  scope: bucket.scope,
  limit: bucket.limit,
  ttlMs: bucket.ttlMs,
  remaining: record.isBlocked ? 0 : Math.max(0, bucket.limit - record.totalHits),
  resetSeconds: record.isBlocked ? record.timeToBlockExpire : record.timeToExpire,
  blocked: record.isBlocked,
  retryAfterSeconds: record.isBlocked ? record.timeToBlockExpire : 0,
});
if (!record.isBlocked) return;
const res = this.responseOf(context);
if (res !== undefined) this.setResponseHeader(res, 'Retry-After', record.timeToBlockExpire);
await this.throwThrottlingException(context, {
  limit: bucket.limit,
  ttl: bucket.ttlMs,
  key,
  tracker: bucket.tracker,
  ...record,
});
```

- Add the method:

```ts
  /**
   * Every guard decision passes here: writes the IETF headers (all budgets of this response, both
   * guards) and is the hook for decision metrics (G-10: count at the TOP of this method, before the
   * early returns, so lockout and WebSocket decisions are counted too). The lockout bucket is never
   * advertised.
   */
  protected recordDecision(context: ExecutionContext, decision: RateLimitDecision): void {
    if (decision.throttler === THROTTLER.LOCKOUT) return;
    const res = this.responseOf(context);
    if (res === undefined) return;
    const all = collectDecision(res, decision);
    this.setResponseHeader(res, 'RateLimit-Policy', formatRateLimitPolicy(all));
    this.setResponseHeader(res, 'RateLimit', formatRateLimit(all));
  }
```

In `libs/redis/src/index.ts`, add:

```ts
export {
  collectDecision,
  formatRateLimit,
  formatRateLimitPolicy,
  policyItemName,
  RATE_LIMIT_HEADER_ORDER,
  type RateLimitDecision,
} from './throttler/rate-limit-headers.js';
```

In `libs/common/src/constants/headers.constants.ts`, inside `HTTP_HEADERS` after `RETRY_AFTER: 'retry-after',`, add:

```ts
  /** draft-ietf-httpapi-ratelimit-headers-11 (set by @platform/redis throttler guards). */
  RATE_LIMIT_POLICY: 'ratelimit-policy',
  RATE_LIMIT: 'ratelimit',
```

In `libs/bootstrap/src/http/create-http-app.ts`, replace

```ts
const EXPOSED_HEADERS = [
  HTTP_HEADERS.REQUEST_ID,
  HTTP_HEADERS.CORRELATION_ID,
  HTTP_HEADERS.RETRY_AFTER,
];
```

with

```ts
const EXPOSED_HEADERS = [
  HTTP_HEADERS.REQUEST_ID,
  HTTP_HEADERS.CORRELATION_ID,
  HTTP_HEADERS.RETRY_AFTER,
  HTTP_HEADERS.RATE_LIMIT_POLICY,
  HTTP_HEADERS.RATE_LIMIT,
];
```

- [ ] **Step 4: Run; expect PASS.**
      `npx vitest run --project redis --project common --project bootstrap`. Expected: PASS.

- [ ] **Step 5: Wider checks.**
      `npx biome check --write libs/redis/src libs/common/src libs/bootstrap/src`, `bun run check`,
      `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off). Expected: PASS.
      Also change the doc comment of `msToSeconds` in `libs/redis/src/throttler/redis-throttler.storage.ts:22` from
      ``/** The storage contract reports seconds (used for `Retry-After` / `X-RateLimit-Reset`). */`` to
      ``/** The storage contract reports seconds (used for `Retry-After` and the IETF `RateLimit` `t=`). */``.
      Then `rg -n 'x-ratelimit' -i apps domains libs` must print nothing outside `docs/` and the
      `toBeUndefined()` assertions on `x-ratelimit-limit`.

- [ ] **Step 6: Commit.**

```bash
git add libs/redis/src libs/common/src/constants/headers.constants.ts libs/bootstrap/src
git commit -m "feat(redis,common,bootstrap): send IETF RateLimit and RateLimit-Policy headers" \
  -m "Implements draft-ietf-httpapi-ratelimit-headers-11 for every budget charged on a request, also on 429 next to Retry-After, and exposes both through CORS. Replaces X-RateLimit-*; the lockout bucket is never advertised."
```

### Task C5: Redis-down modes — budgets fail open (timeout + metric), auth fails closed (C-10)

**Wave:** 1, after C4, in lane `c-throttle`.

**Why:**

- Spec §11 asks for budgets that fail open with a metric and a bounded command timeout, while the `auth` throttler
  fails closed (503).
- Today `failOpen` is one global boolean (`redis-throttler.storage.ts:46`), and only a disconnected client
  short-circuits (`:68`). A connected but hung Redis parks every request until ioredis gives up.

**Files:**

- Modify: `libs/redis/src/throttler/redis-throttler.storage.ts`, `libs/redis/src/throttler/redis-throttler.storage.spec.ts`,
  `libs/redis/src/throttler/app-throttler.module.ts`, `libs/redis/src/throttler/app-throttler.module.spec.ts`,
  `libs/redis/src/index.ts`
- Modify: `libs/config/src/namespaces/throttle.config.ts`, `libs/config/src/namespaces/namespaces.spec.ts`, root `.env.example`

**Interfaces:**

- Consumes: `makeCounterProvider` from `@platform/observability` (a re-export of `@willsoto/nestjs-prometheus` 6.1.1).
  Verified in `node_modules/@willsoto/nestjs-prometheus/dist/metrics/counter.js:9-30` and `utils.js:40-71`:
  - it injects `PROMETHEUS_OPTIONS` as optional, so it works without `ObservabilityModule`;
  - it reuses an already registered metric (`getOrCreateMetric`);
  - its token is `PROM_METRIC_<NAME upper-cased>`.
    The counter is typed structurally (`{ inc(labels: { throttler: string }): void }`), so no `prom-client` import is
    needed.
- Produces:

  ```ts
  export const FAIL_CLOSED_THROTTLERS: ReadonlySet<string>; // new Set(['auth', 'lockout'])
  export const RATE_LIMIT_FAIL_OPEN_TOTAL = 'rate_limit_fail_open_total';
  export interface RedisThrottlerStorageOptions {
    failOpen?: boolean | ((throttlerName: string) => boolean); // default: name => !FAIL_CLOSED_THROTTLERS.has(name)
    commandTimeoutMs?: number; // default 250
    onFailOpen?: (throttlerName: string) => void;
  }
  // ThrottleConfig gains redisTimeoutMs (THROTTLE_REDIS_TIMEOUT_MS, default 250, min 10)
  // AppThrottlerModuleOptions.failOpen becomes `boolean | ((throttlerName: string) => boolean)`
  ```

- [ ] **Step 1: Write the failing tests.** Add this top-level `describe` to
      `libs/redis/src/throttler/redis-throttler.storage.spec.ts`. It uses the file's module-level `keys`
      (`RedisKeyService`) constant and its `InMemoryRedis`, `RedisThrottlerStorage` and `vi` imports:

```ts
describe('Redis down (C-10)', () => {
  it('fails open for budgets and closed (503) for auth and lockout by default', async () => {
    const redis = new InMemoryRedis();
    const onFailOpen = vi.fn();
    const storage = new RedisThrottlerStorage(redis.asRedis(), keys, { onFailOpen });
    redis.simulateOutage();
    for (const name of ['ip', 'user', 'route', 'tenant']) {
      await expect(storage.increment('k', 1_000, 1, 1_000, name)).resolves.toMatchObject({
        isBlocked: false,
      });
    }
    expect(onFailOpen.mock.calls.map(([name]) => name)).toEqual(['ip', 'user', 'route', 'tenant']);
    for (const name of ['auth', 'lockout']) {
      await expect(storage.increment('k', 1_000, 1, 1_000, name)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    }
  });

  it('bounds a hung (connected) Redis with the command timeout', async () => {
    const redis = new InMemoryRedis();
    const client = redis.asRedis();
    const storage = new RedisThrottlerStorage(client, keys, { commandTimeoutMs: 20 });
    Reflect.set(client, 'appThrottleHit', () => new Promise(() => undefined)); // never settles
    const started = Date.now();
    await expect(storage.increment('k', 1_000, 1, 1_000, 'user')).resolves.toMatchObject({
      isBlocked: false,
    });
    await expect(storage.increment('k', 1_000, 1, 1_000, 'auth')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still honours a boolean failOpen for every throttler', async () => {
    const redis = new InMemoryRedis();
    const storage = new RedisThrottlerStorage(redis.asRedis(), keys, { failOpen: true });
    redis.simulateOutage();
    await expect(storage.increment('k', 1_000, 1, 1_000, 'auth')).resolves.toMatchObject({
      isBlocked: false,
    });
  });
});
```

`ServiceUnavailableException` (`libs/common/src/errors/domain.exception.ts:156-166`) sets
`code = ErrorCode.SERVICE_UNAVAILABLE` (`'SERVICE_UNAVAILABLE'`), so the `toMatchObject({ code })` assertions hold.

In `libs/redis/src/throttler/app-throttler.module.spec.ts`, add:

```ts
it('registers the fail-open counter and passes THROTTLE_REDIS_TIMEOUT_MS to the storage', async () => {
  @Module({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      FakeRedisModule,
      AppThrottlerModule.forRootAsync(),
    ],
  })
  class TestModule {}
  app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  const storage = app.get<ThrottlerStorage>(getStorageToken());
  expect(Reflect.get(storage, 'commandTimeoutMs')).toBe(250);
  expect(app.get(RATE_LIMIT_FAIL_OPEN_TOKEN)).toHaveProperty('inc');
});
```

Import `RATE_LIMIT_FAIL_OPEN_TOKEN` from `./redis-throttler.storage.js`.

In `libs/config/src/namespaces/namespaces.spec.ts`, update the C3 assertion to
`toEqual({ ttlMs: 60_000, limit: 300, ipTtlMs: 60_000, ipLimit: 600, redisTimeoutMs: 250 })`.

- [ ] **Step 2: Run; expect FAIL.**
      `npx vitest run --project redis src/throttler/redis-throttler.storage.spec.ts src/throttler/app-throttler.module.spec.ts`
      and `npx vitest run --project config`. Expected: FAIL (auth fails open today; the hung command never resolves past
      the timeout; `redisTimeoutMs` is missing).

- [ ] **Step 3: Implement.**

In `libs/redis/src/throttler/redis-throttler.storage.ts`:

- Replace `RedisThrottlerStorageOptions` with:

```ts
/** Throttlers that refuse (503) instead of letting traffic through when Redis is unusable. */
export const FAIL_CLOSED_THROTTLERS: ReadonlySet<string> = new Set(['auth', 'lockout']);

export const DEFAULT_THROTTLE_COMMAND_TIMEOUT_MS = 250;

export interface RedisThrottlerStorageOptions {
  /**
   * What to do when Redis cannot be reached or does not answer within `commandTimeoutMs`.
   * Default: fail OPEN for budgets (ip/user/route/tenant: a protection, not a correctness feature)
   * and CLOSED (503) for `auth`/`lockout` (an unlimited credential endpoint is a brute-force door).
   * A boolean applies to every throttler.
   */
  failOpen?: boolean | ((throttlerName: string) => boolean);
  /** Upper bound for one throttle command (default 250 ms). */
  commandTimeoutMs?: number;
  /** Called once per request that was let through because of a failure (metrics). */
  onFailOpen?: (throttlerName: string) => void;
}

class ThrottleTimeoutError extends Error {}
```

- In the class:
  - replace `private readonly failOpen: boolean;` with
    `private readonly failOpen: (throttlerName: string) => boolean;`,
    `private readonly commandTimeoutMs: number;` and
    `private readonly onFailOpen: ((throttlerName: string) => void) | undefined;`;
  - in the constructor, replace `this.failOpen = options.failOpen ?? true;` with:

```ts
const failOpen = options.failOpen;
this.failOpen =
  typeof failOpen === 'function'
    ? failOpen
    : failOpen === undefined
      ? (name: string): boolean => !FAIL_CLOSED_THROTTLERS.has(name)
      : (): boolean => failOpen;
this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_THROTTLE_COMMAND_TIMEOUT_MS;
this.onFailOpen = options.onFailOpen;
```

- In `increment`:
  - `return this.onFailure(new Error(\`connection is ${this.redis.status}\`), ttl);`→`return this.onFailure(new Error(\`connection is ${this.redis.status}\`), ttl, throttlerName);`
  - wrap the command:

```ts
const [totalHits, timeToExpireMs, blocked, timeToBlockExpireMs] = await this.withTimeout(
  this.redis.appThrottleHit(
    `${base}:hits`,
    `${base}:block`,
    Math.max(1, Math.ceil(ttl)),
    limit,
    Math.ceil(blockDuration),
  ),
);
```

- `return this.onFailure(error, ttl);` → `return this.onFailure(error, ttl, throttlerName);`.
- Replace `reset` (C2) with this best-effort version (bounded, never throws):

```ts
  /** Deletes one bucket's hit counter (not its block): clears a lockout after a success. Best effort. */
  async reset(key: string, throttlerName: string): Promise<void> {
    if (this.redis.status !== 'ready') return;
    const base = this.keys.key('throttle', hashTag(`${throttlerName}:${key}`));
    try {
      await this.withTimeout(this.redis.del(`${base}:hits`));
    } catch {
      return;
    }
  }
```

- Replace `onFailure` and add `withTimeout`:

```ts
  private async withTimeout<T>(command: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ThrottleTimeoutError(`no reply within ${this.commandTimeoutMs} ms`)),
        this.commandTimeoutMs,
      );
      timer.unref();
    });
    try {
      return await Promise.race([command, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private onFailure(error: unknown, ttl: number, throttlerName: string): ThrottlerStorageRecord {
    if (!this.failOpen(throttlerName)) {
      throw new ServiceUnavailableException('Rate limiter is temporarily unavailable', {
        cause: error,
      });
    }
    this.reportFailure(error);
    this.onFailOpen?.(throttlerName);
    return { totalHits: 0, timeToExpire: msToSeconds(ttl), isBlocked: false, timeToBlockExpire: 0 };
  }
```

- Add near the top:

```ts
export const RATE_LIMIT_FAIL_OPEN_TOTAL = 'rate_limit_fail_open_total';
/** DI token of the counter (`makeCounterProvider` registers `PROM_METRIC_<NAME>`). */
export const RATE_LIMIT_FAIL_OPEN_TOKEN = `PROM_METRIC_${RATE_LIMIT_FAIL_OPEN_TOTAL.toUpperCase()}`;
```

- Update the class doc: "Fails open per throttler (see `RedisThrottlerStorageOptions.failOpen`)".

In `libs/redis/src/throttler/app-throttler.module.ts`:

- `failOpen?: boolean;` → `failOpen?: boolean | ((throttlerName: string) => boolean);`, with the doc
  `/** See RedisThrottlerStorageOptions.failOpen. Default: budgets open, auth/lockout closed. */`.
- Add `import { makeCounterProvider } from '@platform/observability';` (already a dependency of `libs/redis`)
  and `RATE_LIMIT_FAIL_OPEN_TOKEN, RATE_LIMIT_FAIL_OPEN_TOTAL` to the `./redis-throttler.storage.js` import.
- Build the counter provider once:

```ts
const failOpenCounter = makeCounterProvider({
  name: RATE_LIMIT_FAIL_OPEN_TOTAL,
  help: 'Requests let through without rate limiting because Redis was unavailable or slow',
  labelNames: ['throttler'],
});
```

- `ThrottlerModule.forRootAsync({ imports: [ConfigModule.forFeature(throttleConfig)], … })`: the counter must be
  injectable inside that factory. Change it to
  `imports: [ConfigModule.forFeature(throttleConfig), RateLimitMetricsModule]`, where `RateLimitMetricsModule` is
  declared in the same file:

```ts
@Module({ providers: [failOpenCounter], exports: [failOpenCounter] })
class RateLimitMetricsModule {}
```

Then make `inject: [throttleConfig.KEY, REDIS_CLIENT, RedisKeyService, RATE_LIMIT_FAIL_OPEN_TOKEN]` and
give the factory a fourth parameter `failOpenTotal: { inc(labels: { throttler: string }): void }`. Build the storage with:

```ts
            storage: new RedisThrottlerStorage(redis, keys, {
              ...(options.failOpen === undefined ? {} : { failOpen: options.failOpen }),
              commandTimeoutMs: config.redisTimeoutMs,
              onFailOpen: (throttler) => failOpenTotal.inc({ throttler }),
            }),
```

In `libs/redis/src/index.ts`, extend the storage export with
`DEFAULT_THROTTLE_COMMAND_TIMEOUT_MS, FAIL_CLOSED_THROTTLERS, RATE_LIMIT_FAIL_OPEN_TOKEN, RATE_LIMIT_FAIL_OPEN_TOTAL,`.

In `libs/config/src/namespaces/throttle.config.ts`, add `THROTTLE_REDIS_TIMEOUT_MS: zInt(250, { min: 10 }),` and
`/** Bound for one throttle command; past it, budgets fail open and auth fails closed. */ redisTimeoutMs: env.THROTTLE_REDIS_TIMEOUT_MS,`.

In the root `.env.example` throttle section, add:

```
# Bound for one rate-limit Redis command. On timeout or outage, budgets fail OPEN (metric
# rate_limit_fail_open_total) and credential endpoints fail CLOSED (503).
# THROTTLE_REDIS_TIMEOUT_MS=250
```

- [ ] **Step 4: Run; expect PASS.**
      `npx vitest run --project redis --project config --project notifications --project bootstrap`. Expected: PASS.

- [ ] **Step 5: Wider checks.**
      `npx biome check --write libs/redis libs/config/src`, `bun run check`, `node scripts/check-env-example.mjs`,
      `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off). Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add libs/redis libs/config/src .env.example
git commit -m "feat(redis,config): fail budgets open with a timeout and metric, credential limits closed" \
  -m "RedisThrottlerStorage bounds each command (THROTTLE_REDIS_TIMEOUT_MS), counts fail-open requests in rate_limit_fail_open_total{throttler} and answers 503 for auth and lockout when Redis is down or hung."
```

### Task C6: WebSocket errors as `{ ok:false, error }` acks and `exception` events; emit 4xx `details` (C-8, AUDIT-F22)

**Wave:** 1. Start now, in lane `c-ws-errors`, in parallel with `c-throttle`.

**Why:**

- `AllExceptionsFilter` already knows how to answer a Socket.IO client: an ack `{ ok: false, error }`, else an
  `exception` event (`libs/common/src/filters/all-exceptions.filter.ts:110-131`). But gateways never receive it:
  `@nestjs/websockets` `ExceptionFiltersContext.getGlobalMetadata()` returns `[]`, so the `APP_FILTER`
  (`libs/common/src/providers/common-enhancers.ts:102`) is ignored for `@WebSocketGateway`s. A throttled or
  forbidden message falls to Nest's `BaseWsExceptionFilter` (`{ status: 'error', message: 'Internal server error' }`).
- F22: `docs/API.md:280` promises `details.requiredPermissions` on 403. `libs/auth/src/guards/permissions.guard.ts:27`
  and `roles.guard.ts:24` set it, but `toProblemDetails` never emits `details` (`problem-details.ts:95-105`).

The fix:

- a `@UseWsExceptionFilter()` decorator applied to every gateway;
- an allow-listed `details` member, sent only for 4xx `DomainException`s: JSON-safe values only, with `issues`
  removed because it is already `errors`;
- the same member as `extensions.details` in GraphQL.

**Files:**

- Create: `libs/common/src/filters/ws-exception-filter.decorator.ts`, `libs/common/src/filters/ws-exception-filter.decorator.spec.ts`
- Modify: `libs/common/src/filters/all-exceptions.filter.spec.ts`, `libs/common/src/index.ts`
- Modify: `libs/common/src/errors/problem-details.ts`, `libs/common/src/errors/problem-details.spec.ts`
- Modify: `libs/graphql/src/errors/format-graphql-error.ts`, `libs/graphql/src/errors/format-graphql-error.spec.ts`
- Modify: `domains/notifications/src/presentation/ws/notifications.gateway.ts` (`:83`), `domains/notifications/src/presentation/ws/ws-session.guard.spec.ts`

**Interfaces:**

- Consumes: `AllExceptionsFilter`, `DomainException.details` (`domain.exception.ts:26`), `UseFilters`.
- Produces:

  ```ts
  export const UseWsExceptionFilter: () => ClassDecorator & MethodDecorator; // UseFilters(AllExceptionsFilter)
  export interface ProblemDetails {
    /* … */ details?: Record<string, unknown>;
  } // 4xx DomainException only
  export function publicDetails(
    details: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined;
  ```

- [ ] **Step 1: Write the failing tests.**

`libs/common/src/filters/ws-exception-filter.decorator.spec.ts` (`'__exceptionFilters__'` is the value of
`EXCEPTION_FILTERS_METADATA` in `@nestjs/common` 11; confirm with `rg -n EXCEPTION_FILTERS_METADATA node_modules/@nestjs/common/constants.js`):

```ts
import { describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { UseWsExceptionFilter } from './ws-exception-filter.decorator.js';

describe('UseWsExceptionFilter', () => {
  it('binds AllExceptionsFilter (global filters never reach @WebSocketGateway)', () => {
    @UseWsExceptionFilter()
    class Gateway {}
    expect(Reflect.getMetadata('__exceptionFilters__', Gateway)).toEqual([AllExceptionsFilter]);
  });
});
```

In `libs/common/src/filters/all-exceptions.filter.spec.ts`, add next to the existing ws tests (`:152-180`), and
change the file's first import to `import { HttpException, Logger, NotFoundException } from '@nestjs/common';`.
This one is a characterization test: it already passes before Step 3 (the filter handles ws correctly; it was
just never bound to gateways). The pattern string avoids domain words (E plan's libs vocabulary guard):

```ts
it('ws: a throttled message is acked as { ok: false, error: 429 RATE_LIMITED }', () => {
  const ack = vi.fn();
  const host = new ExecutionContextHost([{ emit: vi.fn() }, {}, ack, 'alerts.markRead']);
  host.setType('ws');
  new AllExceptionsFilter(fakeAdapterHost().host).catch(
    new HttpException('ThrottlerException: Too Many Requests', 429),
    host,
  );
  expect(ack).toHaveBeenCalledWith({
    ok: false,
    error: expect.objectContaining({
      status: 429,
      code: 'RATE_LIMITED',
      detail: 'Too many requests. Please retry later.',
    }),
  });
});
```

In `libs/common/src/errors/problem-details.spec.ts`, add the following. `PermissionDeniedException` is the 403
`DomainException` that `libs/auth/src/guards/permissions.guard.ts:27` throws. Add `PermissionDeniedException`,
`DomainValidationException` and `ServiceUnavailableException` to the spec's existing import from
`./domain.exception.js` (whichever of them it does not import yet):

```ts
describe('details (F22)', () => {
  const ctx = { exposeInternal: false };

  it('emits allow-listed details of 4xx domain exceptions', () => {
    const error = new PermissionDeniedException('Missing permission', {
      details: { requiredPermissions: ['users:read'], mode: 'all' },
    });
    expect(toProblemDetails(error, ctx).details).toEqual({
      requiredPermissions: ['users:read'],
      mode: 'all',
    });
  });

  it('drops issues (already errors), non-JSON values and 5xx details', () => {
    const error = new DomainValidationException('Invalid', {
      issues: [{ path: 'a', message: 'b' }],
      details: {
        field: 'a',
        when: new Date(0),
        fn: () => 1,
        nested: { ok: true, err: new Error('x') },
      },
    });
    expect(toProblemDetails(error, ctx).details).toEqual({ field: 'a', nested: { ok: true } });
    const upstream = new ServiceUnavailableException('down', { details: { host: 'db-1' } });
    expect(toProblemDetails(upstream, ctx).details).toBeUndefined();
  });

  it('omits details when nothing public remains', () => {
    const error = new DomainValidationException('Invalid', {
      issues: [{ path: 'a', message: 'b' }],
    });
    expect(toProblemDetails(error, ctx)).not.toHaveProperty('details');
  });
});
```

In `libs/graphql/src/errors/format-graphql-error.spec.ts`, add (import `EntityNotFoundException` from
`@platform/common` and `GraphQLError` from `graphql` if missing):

```ts
it('copies public problem details into extensions.details', () => {
  const format = formatGraphqlError({ exposeInternal: false });
  const original = new EntityNotFoundException('Widget', 'w-1');
  const error = new GraphQLError('x', { path: ['widget'], originalError: original });
  const result = format({ message: 'x', path: ['widget'] }, error);
  expect(result.extensions?.['details']).toEqual({ entity: 'Widget', id: 'w-1' });
});
```

In `domains/notifications/src/presentation/ws/ws-session.guard.spec.ts`, add (import `AllExceptionsFilter` from
`@platform/common`; `NotificationsGateway` is already used by this spec at `:47`):

```ts
it('the notifications gateway delivers errors through AllExceptionsFilter (ack / exception event)', () => {
  expect(Reflect.getMetadata('__exceptionFilters__', NotificationsGateway)).toEqual([
    AllExceptionsFilter,
  ]);
});
```

- [ ] **Step 2: Run; expect FAIL.**
      `npx vitest run --project common src/filters src/errors`, `npx vitest run --project graphql src/errors`,
      `npx vitest run --project notifications src/presentation/ws`. Expected: FAIL (the decorator module is missing,
      `details` is undefined, and the gateway has no filter metadata).

- [ ] **Step 3: Implement.**

`libs/common/src/filters/ws-exception-filter.decorator.ts`:

```ts
import { UseFilters } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

/**
 * Put on every `@WebSocketGateway`. Nest never applies global (APP_FILTER) filters to gateways
 * (`ExceptionFiltersContext.getGlobalMetadata()` returns `[]` in @nestjs/websockets), so without it
 * a 429/403/validation error reaches the client as Nest's generic `{ status: 'error' }`. With it,
 * clients get the problem document: `{ ok: false, error }` through the ack callback when they used
 * `emitWithAck`, else an `exception` event. In the gateway's module the filter options token is
 * absent, so `exposeInternal` is false (5xx messages hidden), which is the safe default.
 */
export const UseWsExceptionFilter = (): ClassDecorator & MethodDecorator =>
  UseFilters(AllExceptionsFilter);
```

In `libs/common/src/index.ts`, after `export * from './filters/all-exceptions.filter.js';`, add
`export * from './filters/ws-exception-filter.decorator.js';`.

In `libs/common/src/errors/problem-details.ts`:

- Add to `ProblemDetails`, after `errors?: unknown[];`:

```ts
  /** Client-safe context of 4xx domain errors (`DomainException.details` minus `issues`). */
  details?: Record<string, unknown>;
```

- Add `details?: Record<string, unknown> | undefined;` to `ResolvedProblem`.
- In `toProblemDetails`, after the `errors` line, add
  `if (base.details !== undefined) problem.details = base.details;`.
- In the `isDomainException` branch of `resolveProblem`, add
  `details: status < 500 ? publicDetails(exception.details) : undefined,` to the returned object.
- Add:

```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function jsonSafe(value: unknown, depth: number): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => jsonSafe(item, depth + 1))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const safe = jsonSafe(item, depth + 1);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }
  return undefined; // Dates, Errors, class instances, functions, symbols, bigint
}

/**
 * The public part of `DomainException.details` (F22): plain JSON values only, at most 4 levels,
 * without `issues` (rendered as `errors`). `DomainExceptionOptions.details` is documented as
 * client-safe; this is the allow-list that enforces "plain data" on top of that contract.
 */
export function publicDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const { issues: _issues, ...rest } = details;
  const safe = jsonSafe(rest, 0);
  if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) return undefined;
  return Object.keys(safe).length > 0 ? safe : undefined;
}
```

`isPlainObject` is already imported from `lodash-es` in this file.

In `libs/graphql/src/errors/format-graphql-error.ts`, after
`if (problem.errors !== undefined) extensions['errors'] = problem.errors;`, add
`if (problem.details !== undefined) extensions['details'] = problem.details;`.

In `domains/notifications/src/presentation/ws/notifications.gateway.ts`:

- `import { toProblemDetails, UnauthenticatedException } from '@platform/common';` →
  `import { toProblemDetails, UnauthenticatedException, UseWsExceptionFilter } from '@platform/common';`;
- insert `@UseWsExceptionFilter()` on the line above `@UseGuards(WsSessionGuard, WsThrottlerGuard)`;
- in the class doc's "Messages:" bullet, add: "Errors (429 included) come back as `{ ok: false, error }` acks or
  `exception` events (`@UseWsExceptionFilter`)."

- [ ] **Step 4: Run; expect PASS.**
      `npx vitest run --project common --project graphql --project notifications --project auth`. Expected: PASS. If an
      existing problem-details or GraphQL assertion uses `toEqual` and now sees the extra `details` (for example,
      `EntityNotFoundException` carries `{ entity, id }`), add `details` to that expectation. The new member is intended.

- [ ] **Step 5: Wider checks.**
      `npx biome check --write libs/common/src libs/graphql/src domains/notifications/src`, `bun run check`,
      `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off). Expected: PASS. Update any e2e `toEqual`
      on a 403/404 problem body in the same way.

- [ ] **Step 6: Commit.**

```bash
git add libs/common/src libs/graphql/src/errors domains/notifications/src/presentation/ws
git commit -m "fix(common,graphql,notifications): deliver ws errors as acks and emit public 4xx details" \
  -m "Gateways never receive APP_FILTER filters; @UseWsExceptionFilter binds AllExceptionsFilter so 429s and other errors reach Socket.IO clients as { ok: false, error } or an exception event. Problem documents (and GraphQL extensions) now carry allow-listed details of 4xx domain errors (AUDIT-F22)."
```

### Task C7: Wave-1 e2e proof and docs (C-11a)

**Wave:** 1. Start after lanes `c-throttle` (C1-C5) and `c-ws-errors` (C6) are merged into `feat/domains-tenancy`.

**Why:** Spec §1 says "every documented rate limit behaves as written, proven by tests". These specs exercise
the real `AppModule` in both topologies. `InMemoryRedis` emulates the throttle Lua script statement by statement
(`libs/redis/src/testing/in-memory-redis.ts:23-48`), so the counts are real. This task also rewrites every doc that
still describes `@AuthThrottle`, `THROTTLE_AUTH_*` or `X-RateLimit-*`.

**Files:**

- Create: `apps/monolith/test/rate-limit.e2e-spec.ts`, `apps/gateway/test/rate-limit.e2e-spec.ts`
- Modify: `docs/CONFIGURATION.md` (namespace table `:91-118`, throttle section `:327-336`), `docs/API.md` (`:34-37`, `:280`),
  `docs/SECURITY.md` (`:98-99`, `:169-172`, `:269`), `docs/ARCHITECTURE.md` (`:386`, `:460`), `docs/PERFORMANCE.md`
  (`:450`, `:525`, `:580`), `docs/TESTING.md` (where e2e specs are listed), `domains/identity/README.md` (`:142-143`,
  `:224`), `domains/billing/README.md` (`:102`, `:323`), `libs/redis/README.md` (`:32-33`, `:79-80`),
  `libs/config/README.md` (`:42`), `README.md` (`:63`), `docker/k6/script.js` (`:12-18`, `:32`)

**Interfaces:**

- Consumes everything from C1-C6.
- Monolith: `createMonolithE2eApp()` returns `{ app, redis, … }` (`apps/monolith/test/support/monolith-e2e-app.ts`,
  where `redis` is the `InMemoryRedis` built at `:63`).
- Gateway: `createGatewayE2eApp()` returns `{ app, redis, identity, notifications, storage }`
  (`apps/gateway/test/support/gateway-e2e-app.ts:90`).
- Helpers: `graphql`, `expectProblem` from `./support/http.js`.

- [ ] **Step 1: Write the e2e specs (they are the proof, so they must pass against the merged code).**

`apps/monolith/test/rate-limit.e2e-spec.ts`:

```ts
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    THROTTLE_IP_LIMIT: '40',
    THROTTLE_LIMIT: '1000',
    IDENTITY_CREDENTIALS_LIMIT: '4',
    IDENTITY_LOCKOUT_THRESHOLD: '50',
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectProblem, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

const LOGIN = 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken } }';
const WRONG = 'wrong password!!';

describe('monolith rate limits (spec §11, wave 1)', () => {
  let e2e: MonolithE2e;
  const inject = (...args: Parameters<MonolithE2e['app']['inject']>) => e2e.app.inject(...args);
  const rest = (email: string) =>
    inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: WRONG } });

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
  });
  beforeEach(async () => {
    await e2e.redis.flushall();
  });
  afterAll(async () => {
    await e2e?.app.close();
  });

  it('sends IETF RateLimit-Policy / RateLimit for every budget charged', async () => {
    const response = await rest('nobody@example.com');
    expect(response.statusCode).toBe(401);
    expect(response.headers['ratelimit-policy']).toBe(
      '"ip";q=40;w=60, "user";q=1000;w=60, "auth:identity.credentials";q=4;w=60',
    );
    expect(response.headers['ratelimit']).toBe(
      '"ip";r=39;t=60, "user";r=999;t=60, "auth:identity.credentials";r=3;t=60',
    );
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('shares one credential bucket between REST and GraphQL, keyed by the normalised email (F17)', async () => {
    const gql = (email: string) => inject(graphql(LOGIN, { input: { email, password: WRONG } }));
    expect((await rest('Bob@Example.com')).statusCode).toBe(401);
    expect((await rest(' bob@example.com')).statusCode).toBe(401);
    const viaGraphql = await gql('BOB@example.com');
    const errors = viaGraphql.json<{ errors: { extensions: { code: string } }[] }>().errors;
    expect(errors[0]?.extensions.code).toBe('INVALID_CREDENTIALS');
    await gql('bob@example.com');
    const limited = await rest('bob@example.com');
    expectProblem(limited, 429, 'RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(String(limited.headers['ratelimit'])).toContain('"auth:identity.credentials";r=0');
    // Another account from the same IP is not affected.
    expect((await rest('carol@example.com')).statusCode).toBe(401);
  });

  it('counts unauthenticated floods before the token is checked; X-Forwarded-For cannot dodge it (TRUST_PROXY=false)', async () => {
    for (let i = 0; i < 40; i += 1) {
      const response = await inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: 'Bearer nope', 'x-forwarded-for': `203.0.113.${i}` },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expectProblem(limited, 429, 'RATE_LIMITED');
    expect((await inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  it('never throttles the Stripe webhook (SkipRateLimit covers every throttler)', async () => {
    for (let i = 0; i < 50; i += 1) {
      const response = await inject({
        method: 'POST',
        url: '/v1/billing/webhooks/stripe',
        headers: { 'content-type': 'application/json' },
        payload: '{"id":"evt_1"}',
      });
      expect(response.statusCode).not.toBe(429);
    }
  });

  it('Redis down: credential endpoints fail closed (503), other budgets fail open', async () => {
    e2e.redis.simulateOutage();
    try {
      expectProblem(await rest('dave@example.com'), 503, 'SERVICE_UNAVAILABLE');
      const refresh = await inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: 'not-a-jwt' },
      });
      // The ip/user budgets let it through: the handler answers (4xx), not the limiter (503).
      expect([400, 401]).toContain(refresh.statusCode);
    } finally {
      e2e.redis.status = 'ready';
    }
  });
});
```

`InMemoryRedis.status` is a public field (`in-memory-redis.ts:60`), so assigning `'ready'` ends the simulated outage.
`GET /v1/auth/me` requires a token (`auth.controller.ts:140`), so every request above is rejected by `JwtAuthGuard`
and still counted by the `ip` throttler.

`apps/gateway/test/rate-limit.e2e-spec.ts`:

```ts
await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV, {
    TRUST_PROXY: 'loopback',
    THROTTLE_LIMIT: '1000',
    IDENTITY_CREDENTIALS_LIMIT: '100',
    IDENTITY_LOCKOUT_THRESHOLD: '3',
    IDENTITY_LOCKOUT_MS: '900000',
  });
});

import type { ProblemDetails } from '@platform/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp } from './support/gateway-e2e-app.js';
import { expectProblem } from './support/http.js';

type GatewayE2e = Awaited<ReturnType<typeof createGatewayE2eApp>>;

const PASSWORD = 'correct horse battery staple';
const WRONG = 'wrong password!!';

describe('gateway rate limits: account lockout across IPs (spec §11, wave 1)', () => {
  let e2e: GatewayE2e;
  let ipSeq = 0;
  const fromNewIp = () => ({ 'x-forwarded-for': `203.0.113.${(ipSeq += 1) % 250}` });
  const login = (email: string, password: string) =>
    e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: fromNewIp(),
      payload: { email, password },
    });
  const register = (email: string) =>
    e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: fromNewIp(),
      payload: { email, password: PASSWORD, displayName: 'E2E' },
    });
  const publicPart = ({ requestId: _r, instance: _i, ...rest }: ProblemDetails) => rest;

  beforeAll(async () => {
    e2e = await createGatewayE2eApp();
  });
  beforeEach(async () => {
    await e2e.redis.flushall();
  });
  afterAll(async () => {
    await e2e?.app.close();
  });

  it('locks an account after THRESHOLD attempts from different IPs, even with the right password', async () => {
    expect((await register('erin@example.com')).statusCode).toBe(201);
    for (let i = 0; i < 3; i += 1)
      expect((await login('erin@example.com', WRONG)).statusCode).toBe(401);
    const locked = await login('erin@example.com', PASSWORD);
    expectProblem(locked, 429, 'RATE_LIMITED');
    const retryAfter = Number(locked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(String(locked.headers['ratelimit'] ?? '')).not.toContain('lockout');
  });

  it('an unknown email locks identically (no account enumeration)', async () => {
    expect((await register('frank@example.com')).statusCode).toBe(201);
    for (let i = 0; i < 3; i += 1) await login('frank@example.com', WRONG);
    const known = expectProblem(await login('frank@example.com', WRONG), 429, 'RATE_LIMITED');
    for (let i = 0; i < 3; i += 1)
      expect((await login('ghost@example.com', WRONG)).statusCode).toBe(401);
    const unknown = expectProblem(await login('ghost@example.com', WRONG), 429, 'RATE_LIMITED');
    expect(publicPart(unknown)).toEqual(publicPart(known));
  });

  it('a successful login resets the count', async () => {
    expect((await register('gina@example.com')).statusCode).toBe(201);
    for (let i = 0; i < 2; i += 1) await login('gina@example.com', WRONG);
    expect((await login('gina@example.com', PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 3; i += 1)
      expect((await login('gina@example.com', WRONG)).statusCode).toBe(401);
  });
});
```

The register call before the lockout counts as a credential attempt, and its success resets the counter. That is
why each case starts from zero after `register`.

- [ ] **Step 2: Run them.**
      `npx vitest run --project monolith:e2e test/rate-limit.e2e-spec.ts` and
      `npx vitest run --project gateway:e2e test/rate-limit.e2e-spec.ts` (sandbox off). Expected: PASS. A failure here is a
      defect in C1-C6: fix it in the owning code together with a unit test, never by loosening the assertion.

- [ ] **Step 3: Docs.** Make these content changes (Prettier re-pads the tables):
- `docs/CONFIGURATION.md`:
  - Replace the throttle table (`:331-336`) with rows for:
    - `THROTTLE_TTL_MS` (60000): "Window of the per-user budget (**milliseconds**)."
    - `THROTTLE_LIMIT` (300): "Requests per window per user (authenticated) or client IP, across all routes (HTTP,
      GraphQL, Socket.IO messages). One shared budget replaces the former per-route buckets, hence 300, not 100."
    - `THROTTLE_IP_TTL_MS` (60000): "Window of the pre-auth per-IP cap."
    - `THROTTLE_IP_LIMIT` (600): "Requests per window per client IP, counted before the token is checked (401/403
      floods count)."
    - `THROTTLE_REDIS_TIMEOUT_MS` (250): "Bound for one rate-limit Redis command. On timeout or outage, budgets fail
      open (`rate_limit_fail_open_total`) and credential endpoints fail closed with 503."
  - Add a section `### identityRateLimit — credential endpoints (identity)`, linked to
    `../domains/identity/src/presentation/rate-limit/identity-rate-limit.config.ts` · gateway, monolith. It has 4 rows:
    - `IDENTITY_CREDENTIALS_LIMIT` (10): "Register/login attempts per sha256(email)+client IP per window, REST and
      GraphQL together."
    - `IDENTITY_CREDENTIALS_TTL_MS` (60000): "Its window."
    - `IDENTITY_LOCKOUT_THRESHOLD` (10): "Consecutive attempts per account (any IP) since the last success before the
      account is refused."
    - `IDENTITY_LOCKOUT_MS` (900000): "How long a locked account is refused (429, like any rate limit)."
  - Add a section `### notificationsRateLimit — Socket.IO message policies (notifications)`, linked to
    `../domains/notifications/src/presentation/ws/notifications-rate-limit.config.ts`, with 2 rows:
    - `NOTIFICATIONS_MARK_READ_LIMIT` (30): "`markRead` messages per user per window."
    - `NOTIFICATIONS_MARK_READ_TTL_MS` (10000): "Its window."
  - In the namespace table, add rows `identityRateLimit` and `notificationsRateLimit`: ✓ monolith, ✓ gateway; Loaded
    by `IdentityApiModule` / `NotificationsApiModule` (`RateLimitModule.forFeature`).
  - Under the throttle table, add a "Renamed (no aliases)" note: "`THROTTLE_AUTH_LIMIT` and `THROTTLE_AUTH_TTL_MS`
    were removed: set `IDENTITY_CREDENTIALS_LIMIT` / `IDENTITY_CREDENTIALS_TTL_MS` instead. In code,
    `@AuthThrottle()` became `@RateLimit('identity.credentials')`, `AUTH_THROTTLE_KEY` became
    `RATE_LIMIT_POLICY_KEY`, `DEFAULT_THROTTLER_NAME` was removed (throttlers are `ip`, `user`, `route`, `auth`), and
    `@SkipThrottle()` must become `@SkipRateLimit()`. The old names are not accepted: the old variables are ignored,
    and `AuthThrottle`/`AUTH_THROTTLE_KEY`/`DEFAULT_THROTTLER_NAME` no longer compile. `SkipThrottle`/`Throttle`
    are still re-exported and still compile, but with no `default` throttler they have NO effect: use
    `SkipRateLimit()`/`RateLimit()`."
- `docs/API.md:34-37`: replace the Rate limiting bullet with:
  "**Rate limiting** (Redis-backed, shared by all replicas). Budgets:
  - `ip`: `THROTTLE_IP_LIMIT`/`_TTL_MS`, default 600/60 s per client IP, counted before authentication.
  - `user`: `THROTTLE_LIMIT`/`_TTL_MS`, default 300/60 s per user (per IP when anonymous), across all routes.
  - Named route policies: `@RateLimit('<domain>.<name>')`, with limits from the domain's env.
  - Register and login: `identity.credentials`, `IDENTITY_CREDENTIALS_LIMIT` per sha256(email)+IP, shared by REST
    and GraphQL. There is also a per-account lockout after `IDENTITY_LOCKOUT_THRESHOLD` attempts without a success,
    for `IDENTITY_LOCKOUT_MS`, answered exactly like any other 429.

  Responses carry `RateLimit-Policy` and `RateLimit` (draft-ietf-httpapi-ratelimit-headers-11), also on 429 next to
  `Retry-After`, and they are exposed through CORS. Socket.IO messages are limited per message; errors come back as
  `{ ok: false, error }` acks or `exception` events. gRPC and Kafka are not throttled. When Redis is down, budgets
  fail open and credential endpoints answer 503."
  After the generic-codes table (`:280`), add: "4xx domain errors carry their public context in `details` (plain JSON
  only), for example `details.requiredPermissions` on 403 and `{ entity, id }` on 404. GraphQL puts the same object
  in `extensions.details`."

- `docs/SECURITY.md:98-99`: replace with "Register and login are limited by `identity.credentials`: per
  sha256(normalised email)+client IP, shared by REST and GraphQL. A per-account lockout (`IDENTITY_LOCKOUT_*`)
  refuses an account after `IDENTITY_LOCKOUT_THRESHOLD` failed attempts from any IP within one
  `IDENTITY_LOCKOUT_MS` window; a successful login before that resets the count. A locked account answers like any 429, so the lockout does not reveal whether an
  account exists. Trade-off (targeted lockout): the lockout is per account by design (spec §11), so anyone who knows
  an email can keep that account locked by failing logins for it, from any IP, for `IDENTITY_LOCKOUT_MS` at a time.
  Keep `IDENTITY_LOCKOUT_MS` short (minutes), keep the threshold high enough for real typos, and watch 429s on
  `/v1/auth/login` per account; a per-IP-only lockout would not stop distributed guessing." Replace the two rows at
  `:169-170` with rows for `THROTTLE_IP_LIMIT` / `_TTL_MS` (600 per 60 s, every HTTP and GraphQL request before
  authentication), `THROTTLE_LIMIT` / `_TTL_MS` (300 per 60 s per user or IP, all routes) and
  `IDENTITY_CREDENTIALS_*` / `IDENTITY_LOCKOUT_*` (10 per 60 s; 10 failed attempts → 15 min). At `:172` and `:269`,
  `@SkipThrottle()` → `@SkipRateLimit()` (it skips every throttler).
- `docs/ARCHITECTURE.md:386`: `` `@AuthThrottle()` `` → `` `@RateLimit('identity.credentials')` ``. At `:460`,
  `` `@SkipThrottle()` `` → `` `@SkipRateLimit()` ``.
- `docs/PERFORMANCE.md:450` and `:580`: `THROTTLE_AUTH_LIMIT` → `IDENTITY_CREDENTIALS_LIMIT`; at `:450`, "per minute
  per IP" → "per minute per email and IP". At `:525`, the `THROTTLE_LIMIT` default `100` → `300`.
- `domains/billing/README.md:102` and `:323`: `@SkipThrottle` → `@SkipRateLimit`.
- `docker/k6/script.js`: in the header comment, "(THROTTLE_AUTH_LIMIT per minute per IP)" → "(IDENTITY_CREDENTIALS_LIMIT
  per minute per email and IP, THROTTLE_IP_LIMIT per minute per IP)" and "default 100/min/user" → "default
  300/min/user"; `const THROTTLE_LIMIT = Number(__ENV.THROTTLE_LIMIT || 100);` → `|| 300`. Run
  `npx biome check --write docker/k6/script.js`.
- `domains/identity/README.md:142-143`: `@AuthThrottle` → `@RateLimit('identity.credentials')`. At `:224`, replace
  the `THROTTLE_AUTH_LIMIT` / `THROTTLE_AUTH_TTL_MS` mention with
  "`identityRateLimit` (`IDENTITY_CREDENTIALS_*`, `IDENTITY_LOCKOUT_*` for `identity.credentials`)".
- `libs/redis/README.md`:
  - Replace the `AuthThrottle()` row (`:32`) and the `SkipThrottle`, `Throttle` re-export row (`:33`: keep it, but say
    "prefer `SkipRateLimit`/`RateLimit`, which know every throttler name") with rows for:
    - `RateLimit(policy)`: route policy;
    - `SkipRateLimit()`: skips every throttler, use it instead of `SkipThrottle()`;
    - `RateLimitModule.forFeature`: domains register policies;
    - `IpThrottlerModule`: import it BEFORE `AuthModule`;
    - `RateLimitPolicyRegistry`.
  - Replace `:79-80` with the five `THROTTLE_*` variables and their defaults (`THROTTLE_LIMIT` 300).
  - Add a "Throttlers" table:

    | Throttler | Key                   | Scope                         |
    | --------- | --------------------- | ----------------------------- |
    | `ip`      | client IP             | `global`                      |
    | `user`    | user id, else IP      | `global`                      |
    | `route`   | user or IP per policy | policy name                   |
    | `auth`    | sha256(email)+IP      | policy name                   |
    | `lockout` | sha256(email)         | policy name, never advertised |
- `libs/config/README.md:42`: the `throttle` row lists `THROTTLE_TTL_MS` (60000), `THROTTLE_LIMIT` (300),
  `THROTTLE_IP_TTL_MS` (60000), `THROTTLE_IP_LIMIT` (600), `THROTTLE_REDIS_TIMEOUT_MS` (250).
- `docs/TESTING.md`: list `apps/*/test/rate-limit.e2e-spec.ts` and `libs/bootstrap/src/rate-limit-order.spec.ts` next to
  the other e2e and smoke specs.
- `README.md:63`: run `bun run test` (sandbox off) and replace "254 test files / 1891 tests" with the file and test
  counts it prints.

Then run two gates:

- docs: `rg -n 'AuthThrottle|THROTTLE_AUTH|X-RateLimit|SkipThrottle|DEFAULT_THROTTLER_NAME|AUTH_THROTTLE_KEY' docs README.md domains/*/README.md libs/*/README.md docker -g '!docs/superpowers/**'`
  must print only the CONFIGURATION.md "Renamed (no aliases)" note and the `libs/redis/README.md` `SkipThrottle`,
  `Throttle` re-export row;
- code: `rg -n 'AuthThrottle|THROTTLE_AUTH|X-RateLimit|DEFAULT_THROTTLER_NAME|AUTH_THROTTLE_KEY' libs domains apps`
  must print nothing. (`SkipThrottle` legitimately stays in code: `rate-limit.decorator.ts` builds `SkipRateLimit`
  from it, the `@platform/redis` re-export, and C1's "raw `@SkipThrottle()`" test.)

Run
`npx prettier --write docs/*.md README.md domains/identity/README.md domains/billing/README.md libs/redis/README.md libs/config/README.md`.

- [ ] **Step 4: Wider checks.** `bun run check`, `bun run test` (sandbox off), `node scripts/check-env-example.mjs`,
      `bun run build`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/monolith/test/rate-limit.e2e-spec.ts apps/gateway/test/rate-limit.e2e-spec.ts docs/*.md README.md domains/identity/README.md domains/billing/README.md libs/redis/README.md libs/config/README.md docker/k6/script.js
git commit -m "test(monolith,gateway): prove the wave-1 rate limits end to end and document them" \
  -m "Covers IETF headers, the REST+GraphQL credential bucket, pre-auth IP counting, spoofed X-Forwarded-For, the webhook exemption, Redis-down modes and the cross-IP account lockout. Docs drop @AuthThrottle, THROTTLE_AUTH_* and X-RateLimit-*."
```

### Task C8: `tenant` throttler — aggregate per-tenant budget (C-2, tenant part)

**Wave:** 2. Waits for B2-18 (token claims `tid`, `AuthUser` gains the active tenant) and B2-22 (principal at
every edge) to be merged into `feat/domains-tenancy`. Lane `c-tenant`.

**Why:** Spec §11 calls for a `tenant` budget keyed by the principal tenant ("aggregate budget, so one noisy tenant
can't starve others"). Before B2 there is no tenant on the request.

**Revalidate first (B2 interface assumed, spec §5.3 and §7):**

- the authenticated user object on `req.user` (HTTP and GraphQL), `socket.data.user` (Socket.IO) and
  `ctx.extra.user` (graphql-ws) carries the active tenant as a non-empty string property `tenantId`;
- staff switch-in tokens carry the target tenant there too.

Run `rg -n 'tenantId|tid' libs/auth/src/types/auth-user.ts libs/auth/src/tokens/token.service.ts`. If B2 named the
field differently (e.g. `tid`), change only the property read in `authenticatedTenantId` below and the fixtures in
this task's tests.

**Files:**

- Modify: `libs/redis/src/throttler/throttle.constants.ts`, `libs/redis/src/throttler/throttle-tracker.util.ts`,
  `libs/redis/src/throttler/rate-limit-guard.base.ts`, `libs/redis/src/throttler/app-throttler.guard.ts`,
  `libs/redis/src/throttler/ws-throttler.guard.ts`, `libs/redis/src/throttler/app-throttler.module.ts`, `libs/redis/src/index.ts`
- Modify: `libs/redis/src/throttler/app-throttler.guard.spec.ts`, `libs/redis/src/throttler/ws-throttler.guard.spec.ts`,
  `libs/redis/src/throttler/throttle-tracker.util.spec.ts` (create it if absent)
- Modify: `libs/config/src/namespaces/throttle.config.ts`, `libs/config/src/namespaces/namespaces.spec.ts`, root `.env.example`

**Interfaces:**

- Consumes (B2): `AuthUser.tenantId: string` (structural read only, no import of `@platform/auth`).
- Produces:

  ```ts
  THROTTLER.TENANT = 'tenant'; // RATE_LIMIT_THROTTLERS gains 'tenant' (SkipRateLimit covers it)
  export function authenticatedTenantId(user: unknown): string | undefined;
  // ThrottleConfig gains tenantTtlMs (THROTTLE_TENANT_TTL_MS, 60000), tenantLimit (THROTTLE_TENANT_LIMIT, 3000)
  ```

- [ ] **Step 1: Write the failing tests.**

`libs/redis/src/throttler/throttle-tracker.util.spec.ts` (add to it if it exists):

```ts
import { describe, expect, it } from 'vitest';
import { authenticatedTenantId } from './throttle-tracker.util.js';

describe('authenticatedTenantId', () => {
  it('reads a non-empty tenantId structurally', () => {
    expect(authenticatedTenantId({ id: 'u', tenantId: 't-1' })).toBe('t-1');
    expect(authenticatedTenantId({ id: 'u', tenantId: '' })).toBeUndefined();
    expect(authenticatedTenantId({ id: 'u', tenantId: null })).toBeUndefined();
    expect(authenticatedTenantId(undefined)).toBeUndefined();
  });
});
```

In `libs/redis/src/throttler/app-throttler.guard.spec.ts`:

- add `{ name: THROTTLER.TENANT, ttl: 60_000, limit: 3_000 }` to `createGuard`'s throttlers;
- add these tests:

```ts
it('charges one tenant budget shared by every member of the tenant', async () => {
  const { guard, increment } = await createGuard();
  await guard.canActivate(
    http(Controller.prototype.list, { headers: {}, user: { id: 'u-1', tenantId: 't-1' } }),
  );
  await guard.canActivate(
    http(Controller.prototype.other, { headers: {}, user: { id: 'u-2', tenantId: 't-1' } }),
  );
  await guard.canActivate(
    http(Controller.prototype.list, { headers: {}, user: { id: 'u-3', tenantId: 't-2' } }),
  );
  const tenantKeys = increment.mock.calls.filter(([, , , , n]) => n === 'tenant').map(([k]) => k);
  expect(tenantKeys).toEqual([
    rateLimitKey('tenant', 'global', 'tenant:t-1'),
    rateLimitKey('tenant', 'global', 'tenant:t-1'),
    rateLimitKey('tenant', 'global', 'tenant:t-2'),
  ]);
});

it('does not charge a tenant for anonymous requests', async () => {
  const { guard, increment } = await createGuard();
  await guard.canActivate(http(Controller.prototype.list));
  expect(increment.mock.calls.map(([, , , , n]) => n)).not.toContain('tenant');
});

it('lists the tenant budget in the IETF headers', async () => {
  const { guard } = await createGuard();
  const res = { header: vi.fn() };
  await guard.canActivate(
    context(
      'http',
      { headers: {}, user: { id: 'u-1', tenantId: 't-1' } },
      Controller.prototype.list,
      res,
    ),
  );
  expect(res.header).toHaveBeenCalledWith(
    'RateLimit-Policy',
    '"user";q=100;w=60, "tenant";q=3000;w=60',
  );
});
```

In `libs/redis/src/throttler/ws-throttler.guard.spec.ts`, add the same tenant throttler to `createGuard`, plus:

```ts
it('charges the socket user tenant per message', async () => {
  const { guard, increment } = await createGuard();
  await guard.canActivate(wsContext({ data: { user: { id: 'u-1', tenantId: 't-9' } } }));
  expect(increment).toHaveBeenCalledWith(
    rateLimitKey('tenant', 'global', 'tenant:t-9'),
    60_000,
    3_000,
    60_000,
    'tenant',
  );
});
```

In `libs/config/src/namespaces/namespaces.spec.ts`, extend the throttle `toEqual` with `tenantTtlMs: 60_000, tenantLimit: 3_000`.

- [ ] **Step 2: Run; expect FAIL.**
      `npx vitest run --project redis src/throttler` and `npx vitest run --project config`. Expected: FAIL
      (`authenticatedTenantId` is not exported; no `tenant` bucket is charged; `tenantLimit` is missing).

- [ ] **Step 3: Implement.**
- `throttle.constants.ts`:
  - add `TENANT: 'tenant',` to `THROTTLER` after `USER`;
  - `RATE_LIMIT_THROTTLERS` becomes `[THROTTLER.IP, THROTTLER.USER, THROTTLER.TENANT, THROTTLER.ROUTE, THROTTLER.AUTH]`;
  - update the doc comment: `tenant` after authentication, and per WebSocket message.
- `throttle-tracker.util.ts`, add:

```ts
/** The active tenant of an authenticated principal (`user.tenantId`, spec §5.3 `tid`), read structurally. */
export function authenticatedTenantId(user: unknown): string | undefined {
  if (typeof user !== 'object' || user === null) return undefined;
  const tenantId: unknown = Reflect.get(user, 'tenantId');
  return isNonEmptyString(tenantId) ? tenantId : undefined;
}
```

- `rate-limit-guard.base.ts`, import `authenticatedTenantId` and add this case to `bucketFor`'s switch, after `USER`:

```ts
      case THROTTLER.TENANT: {
        const tenantId = authenticatedTenantId(subject.user);
        return tenantId === undefined ? undefined : { ...global, tracker: `tenant:${tenantId}` };
      }
```

- `app-throttler.guard.ts` and `ws-throttler.guard.ts`: add `THROTTLER.TENANT` to `enforced`.
- `app-throttler.module.ts`: add `{ name: THROTTLER.TENANT, ttl: config.tenantTtlMs, limit: config.tenantLimit },` after
  the `USER` entry, and this doc bullet: `- tenant: THROTTLE_TENANT_LIMIT per THROTTLE_TENANT_TTL_MS per active tenant (all its members);`.
- `throttle.config.ts`: add `THROTTLE_TENANT_TTL_MS: zInt(60_000, { min: 1 }),`, `THROTTLE_TENANT_LIMIT: zInt(3_000, { min: 1 }),`
  and `/** Aggregate budget of the active tenant (spec §11): one noisy tenant can't starve others. */ tenantTtlMs: env.THROTTLE_TENANT_TTL_MS, tenantLimit: env.THROTTLE_TENANT_LIMIT,`.
- `index.ts`: `export { throttleTracker } from …` becomes `export { authenticatedTenantId, throttleTracker } from './throttler/throttle-tracker.util.js';`.
- Root `.env.example`, in the throttle section:

```
# Aggregate budget per active tenant (all its members together).
# THROTTLE_TENANT_TTL_MS=60000
# THROTTLE_TENANT_LIMIT=3000
```

- [ ] **Step 4: Run; expect PASS.** `npx vitest run --project redis --project config`. Expected: PASS.

- [ ] **Step 5: Wider checks.** `npx biome check --write libs/redis/src libs/config/src`, `bun run check`,
      `node scripts/check-env-example.mjs`, `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off).
      Expected: PASS. The e2e header assertions from C7 now include `"tenant";…` for authenticated requests only; C7's
      assertions are on anonymous login requests, so they are unchanged.

- [ ] **Step 6: Commit.**

```bash
git add libs/redis/src libs/config/src .env.example
git commit -m "feat(redis,config): add the per-tenant aggregate rate-limit budget" \
  -m "The tenant throttler (THROTTLE_TENANT_*) charges every authenticated HTTP, GraphQL and Socket.IO request to the principal's active tenant, so one noisy tenant cannot starve the others."
```

### Task C9: GraphQL per-operation, cost-weighted limiting with HTTP 429 (C-5)

**Wave:** 2, after C8, in lane `c-tenant`.

**Why:**

- Spec §11 says GraphQL is limited per operation, not per root field. The cost is weighted by the complexity score
  the existing plugin computes (`libs/graphql/src/plugins/complexity.plugin.ts:67-84`), and a fully limited
  operation returns HTTP 429.
- Today the global guards run once per resolver, so an operation with 10 root fields costs 10 requests, and a
  single expensive operation costs 1.

This task:

- charges the global `ip`/`user`/`tenant` budgets once per GraphQL HTTP request (de-duplicated per request object;
  route and credential policies still apply per resolver, which is what they are for);
- adds a `graphql` cost budget, charged once per operation by an Apollo plugin with weight = complexity (at least 1).

**Files:**

- Modify: `libs/redis/src/throttler/throttle.command.ts` (weighted `INCRBY`), `libs/redis/src/testing/in-memory-redis.ts`
  (`throttleScriptModel`), `libs/redis/src/throttler/redis-throttler.storage.ts` (`incrementBy`)
- Create: `libs/redis/src/throttler/rate-limit-charger.ts`, `libs/redis/src/throttler/rate-limit-charger.spec.ts`
- Modify: `libs/redis/src/throttler/rate-limit-guard.base.ts` (once-per-GraphQL-request de-duplication),
  `libs/redis/src/throttler/app-throttler.module.ts`, `libs/redis/src/index.ts`, `libs/redis/src/throttler/throttle.constants.ts`
- Modify: `libs/redis/src/throttler/redis-throttler.storage.spec.ts`, `libs/redis/src/throttler/app-throttler.guard.spec.ts`,
  `libs/redis/src/throttler/throttle.command.int-spec.ts` (weighted case)
- Create: `libs/graphql/src/plugins/operation-rate-limit.plugin.ts`, `libs/graphql/src/plugins/operation-rate-limit.plugin.spec.ts`
- Modify: `libs/graphql/src/graphql.module.ts` (`:84` providers), `libs/graphql/src/index.ts`
- Modify: `libs/config/src/namespaces/throttle.config.ts`, `libs/config/src/namespaces/namespaces.spec.ts`, root `.env.example`

**Interfaces:**

- Consumes: `measureComplexity`, `isIntrospectionOnly` (`complexity.plugin.ts:50-84`), `RateLimitBucket`,
  `collectDecision`/`formatRateLimit*` (C4), `authenticatedUserId`, `authenticatedTenantId`.
- Produces:

  ```ts
  THROTTLER.GRAPHQL = 'graphql'; // NOT in RATE_LIMIT_THROTTLERS (not a ThrottlerGuard throttler); SkipRateLimit doesn't apply
  RedisThrottlerStorage.incrementBy(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string, weight: number): Promise<ThrottlerStorageRecord>;
  export class RateLimitCharger {
    charge(bucket: RateLimitBucket, weight?: number): Promise<{ record: ThrottlerStorageRecord; decision: RateLimitDecision }>;
  }
  export class OperationRateLimitPlugin implements ApolloServerPlugin<BaseContext>; // @platform/graphql
  export const GRAPHQL_RATE_LIMITED = 'RATE_LIMITED';
  // ThrottleConfig gains graphqlTtlMs (THROTTLE_GRAPHQL_TTL_MS, 60000), graphqlCostLimit (THROTTLE_GRAPHQL_COST_LIMIT, 20000)
  ```

- [ ] **Step 1: Write the failing tests.**

In `libs/redis/src/throttler/redis-throttler.storage.spec.ts`, add at the top level (it uses C2's module-level
`makeStorage`):

```ts
it('incrementBy() adds the weight and blocks once the weighted total passes the limit', async () => {
  const storage = makeStorage();
  await expect(
    storage.incrementBy('op', 60_000, 100, 60_000, 'graphql', 60),
  ).resolves.toMatchObject({ totalHits: 60, isBlocked: false });
  await expect(
    storage.incrementBy('op', 60_000, 100, 60_000, 'graphql', 40),
  ).resolves.toMatchObject({ totalHits: 100, isBlocked: false });
  await expect(storage.incrementBy('op', 60_000, 100, 60_000, 'graphql', 1)).resolves.toMatchObject(
    { isBlocked: true },
  );
  await expect(storage.increment('one', 60_000, 1, 0, 'user')).resolves.toMatchObject({
    totalHits: 1,
  });
});
```

In `libs/redis/src/throttler/throttle.command.int-spec.ts`, add the same weighted sequence against real Redis
(`appThrottleHit(hits, block, 60000, 100, 60000, 60)` → `[60, …, 0, 0]`, then weight 40 → `[100, …, 0, 0]`, then
weight 1 → blocked `[101, 60000, 1, 60000]`). Follow the file's existing `appThrottleHit` call style.

`libs/redis/src/throttler/rate-limit-charger.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RateLimitCharger } from './rate-limit-charger.js';
import { rateLimitKey } from './rate-limit-key.util.js';

describe('RateLimitCharger', () => {
  it('increments the bucket by weight and returns the IETF decision', async () => {
    const incrementBy = vi.fn(async () => ({
      totalHits: 150,
      timeToExpire: 30,
      isBlocked: false,
      timeToBlockExpire: 0,
    }));
    const charger = new RateLimitCharger({ increment: vi.fn(), incrementBy });
    const bucket = {
      throttler: 'graphql',
      scope: 'cost',
      tracker: 'user:u-1',
      limit: 1_000,
      ttlMs: 60_000,
      blockMs: 60_000,
    };
    const { decision } = await charger.charge(bucket, 50);
    expect(incrementBy).toHaveBeenCalledWith(
      rateLimitKey('graphql', 'cost', 'user:u-1'),
      60_000,
      1_000,
      60_000,
      'graphql',
      50,
    );
    expect(decision).toMatchObject({
      throttler: 'graphql',
      scope: 'cost',
      remaining: 850,
      resetSeconds: 30,
      blocked: false,
    });
  });

  it('falls back to increment() (weight 1) for storages without incrementBy', async () => {
    const increment = vi.fn(async () => ({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    }));
    const charger = new RateLimitCharger({ increment });
    await charger.charge(
      { throttler: 'graphql', scope: 'cost', tracker: 't', limit: 5, ttlMs: 1_000, blockMs: 0 },
      7,
    );
    expect(increment).toHaveBeenCalledTimes(1);
  });
});
```

In `libs/redis/src/throttler/app-throttler.guard.spec.ts`, add (the third test of this block is in Step 3 below):

```ts
it('charges the global budgets once per GraphQL request, however many root fields run', async () => {
  const { guard, increment } = await createGuard();
  const req = { headers: {}, user: { id: 'u-1', tenantId: 't-1' } };
  for (let i = 0; i < 5; i += 1) await guard.canActivate(context('graphql', req));
  expect(increment.mock.calls.filter(([, , , , n]) => n === 'user')).toHaveLength(1);
  expect(increment.mock.calls.filter(([, , , , n]) => n === 'tenant')).toHaveLength(1);
});

it('still charges a route policy per resolver', async () => {
  const { guard, increment } = await createGuard();
  const req = { headers: {}, user: { id: 'u-1' } };
  await guard.canActivate(context('graphql', req, Controller.prototype.upload));
  await guard.canActivate(context('graphql', req, Controller.prototype.upload));
  expect(increment.mock.calls.filter(([, , , , n]) => n === 'route')).toHaveLength(2);
});
```

`libs/graphql/src/plugins/operation-rate-limit.plugin.spec.ts`:

```ts
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { throttleConfig } from '@platform/config';
import { buildSchema, GraphQLError, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { OperationRateLimitPlugin } from './operation-rate-limit.plugin.js';

const schema = buildSchema('type Query { a: Int b: Int items: [Int] }');

function setup(
  record = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 },
) {
  const charge = vi.fn(
    async (
      bucket: { limit: number; throttler: string; scope: string; ttlMs: number },
      weight = 1,
    ) => ({
      record,
      decision: {
        throttler: bucket.throttler,
        scope: bucket.scope,
        limit: bucket.limit,
        ttlMs: bucket.ttlMs,
        remaining: record.isBlocked ? 0 : bucket.limit - weight,
        resetSeconds: record.isBlocked ? record.timeToBlockExpire : record.timeToExpire,
        blocked: record.isBlocked,
        retryAfterSeconds: record.timeToBlockExpire,
      },
    }),
  );
  const plugin = new OperationRateLimitPlugin(
    { schema } as unknown as GraphQLSchemaHost,
    throttleConfig.parse({ THROTTLE_GRAPHQL_COST_LIMIT: '100' }),
    { charge } as never,
  );
  return { plugin, charge };
}

async function run(
  plugin: OperationRateLimitPlugin,
  query: string,
  contextValue: Record<string, unknown>,
) {
  const listener = await plugin.requestDidStart();
  const headers = new Map<string, string>();
  const reply = { header: vi.fn((name: string, value: string) => headers.set(name, value)) };
  await listener.didResolveOperation?.({
    request: { query },
    document: parse(query),
    contextValue: { reply, ...contextValue },
    response: { http: { headers: new Map(), status: undefined } },
  } as never);
  return headers;
}

describe('OperationRateLimitPlugin', () => {
  it('charges once per operation with weight = complexity, keyed by user', async () => {
    const { plugin, charge } = setup();
    const headers = await run(plugin, '{ a b items }', {
      req: { user: { id: 'u-1' }, ip: '1.2.3.4' },
    });
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({
        throttler: 'graphql',
        scope: 'cost',
        tracker: 'user:u-1',
        limit: 100,
      }),
      3,
    );
    expect(headers.get('ratelimit-policy')).toBe('"graphql:cost";q=100;w=60');
  });

  it('falls back to the client IP and skips introspection-only operations', async () => {
    const { plugin, charge } = setup();
    await run(plugin, '{ a }', { req: { ip: '1.2.3.4' } });
    expect(charge.mock.calls[0]?.[0]).toMatchObject({ tracker: 'ip:1.2.3.4' });
    charge.mockClear();
    await run(plugin, '{ __schema { queryType { name } } }', { req: { ip: '1.2.3.4' } });
    expect(charge).not.toHaveBeenCalled();
  });

  it('rejects a fully limited operation with HTTP 429 RATE_LIMITED and Retry-After', async () => {
    const { plugin } = setup({
      totalHits: 101,
      timeToExpire: 0,
      isBlocked: true,
      timeToBlockExpire: 17,
    });
    const rejection = run(plugin, '{ a }', { req: { user: { id: 'u-1' } } });
    await expect(rejection).rejects.toBeInstanceOf(GraphQLError);
    await expect(rejection).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED', http: { status: 429, headers: expect.any(Map) } },
    });
  });

  it('is a no-op without a charger (apps without AppThrottlerModule)', async () => {
    const plugin = new OperationRateLimitPlugin(
      { schema } as unknown as GraphQLSchemaHost,
      throttleConfig.parse({}),
      undefined,
    );
    await expect(run(plugin, '{ a }', { req: {} })).resolves.toBeInstanceOf(Map);
  });
});
```

In `libs/config/src/namespaces/namespaces.spec.ts`, extend the throttle `toEqual` with
`graphqlTtlMs: 60_000, graphqlCostLimit: 20_000`.

- [ ] **Step 2: Run; expect FAIL.**
      `npx vitest run --project redis src/throttler src/testing`, `npx vitest run --project graphql src/plugins`,
      `npx vitest run --project config`. Expected: FAIL (`incrementBy` and `RateLimitCharger` are missing, the plugin
      module is missing, and GraphQL budgets are charged per resolver).

- [ ] **Step 3: Implement.**

`libs/redis/src/throttler/throttle.command.ts`:

- In `THROTTLE_SCRIPT`, replace `local hits = redis.call('INCR', KEYS[1])` with
  `local hits = redis.call('INCRBY', KEYS[1], tonumber(ARGV[4]) or 1)`.
- Doc: "ARGV[4] weight (default 1; GraphQL cost)".
- In the `RedisCommander` declaration, add a sixth parameter `weight?: number`.

`libs/redis/src/testing/in-memory-redis.ts`, in `throttleScriptModel`:

- `const [ttl = 0, limit = 0, block = 0] = args.map(Number);` → `const [ttl = 0, limit = 0, block = 0, weight = 1] = args.map(Number);`
- replace `const hits = redis.incrSync(hitsKey);` with
  `let hits = 0; for (let i = 0; i < Math.max(1, weight); i += 1) hits = redis.incrSync(hitsKey);`. This keeps the
  model statement-by-statement equivalent to `INCRBY` without a new primitive.

`libs/redis/src/throttler/redis-throttler.storage.ts`:

- rename the body of `increment` into
  `async incrementBy(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string, weight: number): Promise<ThrottlerStorageRecord>`;
- pass `Math.max(1, Math.ceil(weight))` as the sixth `appThrottleHit` argument;
- make `increment(key, ttl, limit, blockDuration, throttlerName)` return
  `this.incrementBy(key, ttl, limit, blockDuration, throttlerName, 1)`.

`libs/redis/src/throttler/throttle.constants.ts`: add `GRAPHQL: 'graphql',` to `THROTTLER` (not to `RATE_LIMIT_THROTTLERS`),
and add `'graphql'` after `'tenant'` in `RATE_LIMIT_HEADER_ORDER` (`rate-limit-headers.ts`).

`libs/redis/src/throttler/rate-limit-charger.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler';
import type { RateLimitBucket } from './rate-limit-guard.base.js';
import type { RateLimitDecision } from './rate-limit-headers.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';

interface WeightedStorage extends ThrottlerStorage {
  incrementBy(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
    weight: number,
  ): Promise<ThrottlerStorageRecord>;
}

const isWeighted = (storage: ThrottlerStorage): storage is WeightedStorage =>
  typeof Reflect.get(storage, 'incrementBy') === 'function';

/** Charges a bucket outside the guard pipeline (GraphQL plugin, graphql-ws), by weight. */
@Injectable()
export class RateLimitCharger {
  constructor(@InjectThrottlerStorage() private readonly storage: ThrottlerStorage) {}

  async charge(
    bucket: RateLimitBucket,
    weight = 1,
  ): Promise<{ record: ThrottlerStorageRecord; decision: RateLimitDecision }> {
    const key = rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker);
    const storage = this.storage;
    const record = isWeighted(storage)
      ? await storage.incrementBy(
          key,
          bucket.ttlMs,
          bucket.limit,
          bucket.blockMs,
          bucket.throttler,
          weight,
        )
      : await storage.increment(key, bucket.ttlMs, bucket.limit, bucket.blockMs, bucket.throttler);
    const decision: RateLimitDecision = {
      throttler: bucket.throttler,
      scope: bucket.scope,
      limit: bucket.limit,
      ttlMs: bucket.ttlMs,
      remaining: record.isBlocked ? 0 : Math.max(0, bucket.limit - record.totalHits),
      resetSeconds: record.isBlocked ? record.timeToBlockExpire : record.timeToExpire,
      blocked: record.isBlocked,
      retryAfterSeconds: record.isBlocked ? record.timeToBlockExpire : 0,
    };
    return { record, decision };
  }
}
```

Add `RateLimitCharger` to `AppThrottlerModule`'s `providers` and `exports`, and export it from `libs/redis/src/index.ts`.

`libs/redis/src/throttler/rate-limit-guard.base.ts`, once-per-GraphQL-request de-duplication. The outcome is
remembered, not just the fact of the charge: when the first root field was refused, every later root field of the
same request is refused too (otherwise `{ a b }` would run `b` past a blocked budget). Add near the top:

```ts
/**
 * Global budgets already charged for one GraphQL request (one operation, many root resolvers): the
 * refusal to repeat (`ThrottlerLimitDetail`) or `null` when the budget admitted the request. graphql-ws
 * builds a fresh `req` per operation (`buildWsRequest`), so subscriptions are charged once each.
 */
const chargedGraphqlRequests = new WeakMap<object, Map<string, ThrottlerLimitDetail | null>>();
```

Change the `@nestjs/throttler` import of this file to
`import { normalizeIp, ThrottlerGuard, type ThrottlerLimitDetail, type ThrottlerRequest } from '@nestjs/throttler';`
and import `getContextType` from `@platform/common` (already a dependency of `libs/redis`). Then replace the body of
`charge(...)` (C4 version) with:

```ts
let charged: Map<string, ThrottlerLimitDetail | null> | undefined;
if (bucket.scope === GLOBAL_SCOPE && getContextType(context) === 'graphql') {
  const req = context.getArgByIndex<{ req?: object } | undefined>(2)?.req;
  if (req !== undefined) {
    charged = chargedGraphqlRequests.get(req) ?? new Map<string, ThrottlerLimitDetail | null>();
    chargedGraphqlRequests.set(req, charged);
    if (charged.has(bucket.throttler)) {
      const refusal = charged.get(bucket.throttler);
      if (refusal) await this.throwThrottlingException(context, refusal);
      return;
    }
  }
}
const key = rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker);
const record = await this.storageService.increment(
  key,
  bucket.ttlMs,
  bucket.limit,
  bucket.blockMs,
  bucket.throttler,
);
this.recordDecision(context, {
  throttler: bucket.throttler,
  scope: bucket.scope,
  limit: bucket.limit,
  ttlMs: bucket.ttlMs,
  remaining: record.isBlocked ? 0 : Math.max(0, bucket.limit - record.totalHits),
  resetSeconds: record.isBlocked ? record.timeToBlockExpire : record.timeToExpire,
  blocked: record.isBlocked,
  retryAfterSeconds: record.isBlocked ? record.timeToBlockExpire : 0,
});
const detail: ThrottlerLimitDetail = {
  limit: bucket.limit,
  ttl: bucket.ttlMs,
  key,
  tracker: bucket.tracker,
  ...record,
};
charged?.set(bucket.throttler, record.isBlocked ? detail : null);
if (!record.isBlocked) return;
const res = this.responseOf(context);
if (res !== undefined) this.setResponseHeader(res, 'Retry-After', record.timeToBlockExpire);
await this.throwThrottlingException(context, detail);
```

Add this test to the C9 block of `app-throttler.guard.spec.ts`:

```ts
it('refuses every later root field of a GraphQL request once a global budget refused it', async () => {
  const { guard, increment } = await createGuard();
  increment.mockResolvedValue(record({ isBlocked: true, totalHits: 101, timeToBlockExpire: 5 }));
  const req = { headers: {}, user: { id: 'u-1' } };
  await expect(guard.canActivate(context('graphql', req))).rejects.toBeInstanceOf(
    ThrottlerException,
  );
  await expect(guard.canActivate(context('graphql', req))).rejects.toBeInstanceOf(
    ThrottlerException,
  );
  expect(increment.mock.calls.filter(([, , , , n]) => n === 'user')).toHaveLength(1);
});
```

`libs/graphql/src/plugins/operation-rate-limit.plugin.ts`:

```ts
import type { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import { Plugin } from '@nestjs/apollo';
import { Inject, Optional } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { type ThrottleConfig, throttleConfig } from '@platform/config';
import {
  authenticatedUserId,
  collectDecision,
  formatRateLimit,
  formatRateLimitPolicy,
  RateLimitCharger,
  THROTTLER,
} from '@platform/redis';
import { GraphQLError } from 'graphql';
import { isIntrospectionOnly, measureComplexity } from './complexity.plugin.js';

export const GRAPHQL_RATE_LIMITED = 'RATE_LIMITED';

interface GqlRequestLike {
  user?: unknown;
  ip?: unknown;
}

/** The Fastify reply in the GraphQL context (`{ req, reply }`, built by createGraphqlContext). */
interface HeaderReply {
  header(name: string, value: string): unknown;
}

/**
 * Per-OPERATION GraphQL limiting (spec §11): one charge per operation on the `graphql` cost budget
 * (`THROTTLE_GRAPHQL_COST_LIMIT` per `THROTTLE_GRAPHQL_TTL_MS`, per user, else per client IP), weighted
 * by the operation's complexity (the same estimators as `ComplexityPlugin`, minimum 1). A fully
 * limited operation fails BEFORE any resolver runs with HTTP 429, `extensions.code: RATE_LIMITED`,
 * `Retry-After` and the IETF headers. Introspection-only operations are exempt.
 */
@Plugin()
export class OperationRateLimitPlugin implements ApolloServerPlugin<BaseContext> {
  constructor(
    private readonly schemaHost: GraphQLSchemaHost,
    @Inject(throttleConfig.KEY) private readonly limits: ThrottleConfig,
    // Explicit token: a `T | undefined` parameter type is emitted as `Object` in design:paramtypes.
    @Optional() @Inject(RateLimitCharger) private readonly charger?: RateLimitCharger,
  ) {}

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    const charger = this.charger;
    if (charger === undefined) return {};
    const schema = this.schemaHost.schema;
    const { graphqlCostLimit, graphqlTtlMs } = this.limits;
    return {
      async didResolveOperation({ request, document, contextValue }) {
        if (isIntrospectionOnly(document, request.operationName)) return;
        const cost = measureComplexity({
          schema,
          document,
          operationName: request.operationName,
          variables: request.variables,
        });
        const ctx = contextValue as { req?: GqlRequestLike; reply?: HeaderReply };
        const req = ctx.req ?? {};
        const userId = authenticatedUserId(req.user);
        const tracker = userId
          ? `user:${userId}`
          : `ip:${typeof req.ip === 'string' ? req.ip : 'unknown'}`;
        const { record, decision } = await charger.charge(
          {
            throttler: THROTTLER.GRAPHQL,
            scope: 'cost',
            tracker,
            limit: graphqlCostLimit,
            ttlMs: graphqlTtlMs,
            blockMs: graphqlTtlMs,
          },
          Math.max(1, cost ?? 1),
        );
        // Same per-response list as the guards (they key on the Fastify reply), so one
        // RateLimit-Policy / RateLimit pair lists ip, user, tenant AND graphql:cost.
        if (ctx.reply !== undefined) {
          const all = collectDecision(ctx.reply, decision);
          ctx.reply.header('ratelimit-policy', formatRateLimitPolicy(all));
          ctx.reply.header('ratelimit', formatRateLimit(all));
        }
        if (!record.isBlocked) return;
        const retry = new Map<string, string>([['retry-after', String(record.timeToBlockExpire)]]);
        ctx.reply?.header('retry-after', String(record.timeToBlockExpire));
        throw new GraphQLError('Too many requests. Please retry later.', {
          extensions: {
            code: GRAPHQL_RATE_LIMITED,
            status: 429,
            http: { status: 429, headers: retry },
          },
        });
      },
    };
  }
}
```

`authenticatedUserId` must be exported from `@platform/redis`: add
`export { authenticatedTenantId, authenticatedUserId, throttleTracker } from './throttler/throttle-tracker.util.js';`.
The proxy-aware `req.ip` comes from Fastify for HTTP. For graphql-ws, C10 makes `buildWsRequest` proxy-aware.
`collectDecision` keys on the Fastify reply in the GraphQL context, the same object the guards use
(`AppThrottlerGuard.getRequestResponse`, `gql.reply`). So the plugin's `graphql:cost` entry joins the guards' list
instead of overwriting it.

`libs/graphql/src/graphql.module.ts:84`: `providers: [ComplexityPlugin, ErrorRequestIdPlugin, SandboxCspHook]` →
`providers: [ComplexityPlugin, OperationRateLimitPlugin, ErrorRequestIdPlugin, SandboxCspHook]`. In the same
`AppGraphqlModule.forRootAsync` return value, add `ConfigModule.forFeature(throttleConfig),` to the TOP-LEVEL `imports`
(next to `ConfigModule.forFeature(graphqlConfig),`, not inside `GraphQLModule.forRootAsync`), and add `throttleConfig`
to the file's `@platform/config` import. `RateLimitCharger` comes from the global `AppThrottlerModule`; an app
without it gets a no-op plugin. Export the plugin and `GRAPHQL_RATE_LIMITED` from `libs/graphql/src/index.ts`.

`throttle.config.ts`: add `THROTTLE_GRAPHQL_TTL_MS: zInt(60_000, { min: 1 }),`, `THROTTLE_GRAPHQL_COST_LIMIT: zInt(20_000, { min: 1 }),`
and `/** GraphQL cost budget per user (else IP): sum of operation complexities per window. */ graphqlTtlMs: env.THROTTLE_GRAPHQL_TTL_MS, graphqlCostLimit: env.THROTTLE_GRAPHQL_COST_LIMIT,`.

Root `.env.example`, throttle section:

```
# GraphQL: one charge per operation, weighted by its complexity score, per user (else IP).
# THROTTLE_GRAPHQL_TTL_MS=60000
# THROTTLE_GRAPHQL_COST_LIMIT=20000
```

- [ ] **Step 4: Run; expect PASS.**
      `npx vitest run --project redis --project graphql --project config`. Expected: PASS. Also run
      `REDIS_URL=redis://127.0.0.1:16379 INTEGRATION=1 npx vitest run --project redis:int` against an isolated Redis
      (conventions §8). Expected: PASS. This proves the Lua `INCRBY` change.

- [ ] **Step 5: Wider checks.** `npx biome check --write libs/redis libs/graphql/src libs/config/src`, `bun run check`,
      `node scripts/check-env-example.mjs`, `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off).
      Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add libs/redis libs/graphql/src libs/config/src .env.example
git commit -m "feat(graphql,redis,config): limit GraphQL per operation, weighted by complexity" \
  -m "OperationRateLimitPlugin charges THROTTLE_GRAPHQL_COST_LIMIT once per operation by its complexity and answers 429 RATE_LIMITED before any resolver runs; ip/user/tenant budgets are charged once per GraphQL request instead of once per root field."
```

### Task C10: graphql-ws runs the complexity check and the per-operation limit; proxy-aware graphql-ws IP (C-6)

**Wave:** 2, after C9, in lane `c-tenant`.

**Why:**

- Apollo plugins never see graphql-ws operations. Nest hands them straight to `useServer({ schema, execute,
subscribe, context, ...options['graphql-ws'] })` (`node_modules/@nestjs/graphql/dist/services/gql-subscription.service.js:20-26`),
  so `ComplexityPlugin` and C9's plugin are bypassed on subscriptions (spec §11: "The graphql-ws path also runs the
  complexity check").
- `buildWsRequest` takes `req.ip` from the raw socket (`libs/graphql/src/context/graphql-context.factory.ts`), not
  through `TRUST_PROXY`.

graphql-ws 6.3.0 `onSubscribe(ctx, id, payload)` may return `readonly GraphQLError[]` to reject the subscription
(`node_modules/graphql-ws/dist/server-BzBeHlSW.d.ts:241`). The schema only exists after the GraphQL module has
booted. So a `SubscriptionGuardRef` holder is created in `AppGraphqlModule.forRootAsync`, and a provider fills it in
`onApplicationBootstrap` (the same holder pattern as `libs/redis/src/lock/lock-registry.ts`).

**Files:**

- Create: `libs/graphql/src/subscriptions/subscription-guard.ts`, `libs/graphql/src/subscriptions/subscription-guard.spec.ts`
- Modify: `libs/graphql/src/apollo-config.factory.ts` (`ApolloConfigDeps`, `subscriptions['graphql-ws']`),
  `libs/graphql/src/graphql.module.ts`, `libs/graphql/src/context/graphql-context.factory.ts`,
  `libs/graphql/src/context/graphql-context.factory.spec.ts` (create it if absent), `libs/graphql/src/index.ts`

**Interfaces:**

- Consumes: `measureComplexity`, `isIntrospectionOnly`, `QUERY_TOO_COMPLEX` (`complexity.plugin.ts`), `RateLimitCharger`,
  `THROTTLER.GRAPHQL`, `authenticatedUserId`, `createClientIpResolver` (C3), `GraphqlConfig.maxComplexity`,
  `ThrottleConfig.graphqlCostLimit/graphqlTtlMs`.
- Produces:

  ```ts
  export interface SubscriptionCheckInput {
    document: DocumentNode;
    operationName?: string | null | undefined;
    variables?: Record<string, unknown> | undefined;
    user: unknown;
    ip: string | undefined;
  }
  export type SubscriptionCheck = (
    input: SubscriptionCheckInput,
  ) => Promise<readonly GraphQLError[] | undefined>;
  export class SubscriptionGuardRef {
    bind(check: SubscriptionCheck): void;
    run(input: SubscriptionCheckInput): Promise<readonly GraphQLError[] | undefined>;
  }
  export class SubscriptionGuardBinder implements OnApplicationBootstrap {}
  export function createSubscriptionCheck(deps: {
    schema: () => GraphQLSchema;
    maxComplexity: number;
    costLimit: number;
    costTtlMs: number;
    charger: RateLimitCharger | undefined;
  }): SubscriptionCheck;
  // ApolloConfigDeps gains: subscriptionGuard?: SubscriptionGuardRef
  // buildWsRequest(ctx, clientIp?: ClientIpResolver); createGraphqlContext(loaders, clientIp?: ClientIpResolver)
  ```

- [ ] **Step 1: Write the failing tests.**

`libs/graphql/src/subscriptions/subscription-guard.spec.ts`:

```ts
import { buildSchema, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionCheck, SubscriptionGuardRef } from './subscription-guard.js';

const schema = buildSchema('type Query { a: Int } type Subscription { tick: Int items: [Int] }');
const input = (query: string, user: unknown = { id: 'u-1' }) => ({
  document: parse(query),
  user,
  ip: '1.2.3.4',
});

const charger = (blocked = false) => ({
  charge: vi.fn(async () => ({
    record: {
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: blocked,
      timeToBlockExpire: blocked ? 9 : 0,
    },
    decision: {} as never,
  })),
});

describe('graphql-ws subscription check (C-6)', () => {
  it('rejects a subscription above GRAPHQL_MAX_COMPLEXITY with QUERY_TOO_COMPLEX', async () => {
    const check = createSubscriptionCheck({
      schema: () => schema,
      maxComplexity: 1,
      costLimit: 100,
      costTtlMs: 60_000,
      charger: undefined,
    });
    const errors = await check(input('subscription { tick items }'));
    expect(errors?.[0]?.extensions).toMatchObject({
      code: 'QUERY_TOO_COMPLEX',
      complexity: 2,
      maxComplexity: 1,
    });
  });

  it('charges the graphql cost budget once per subscription, keyed by user, weighted by cost', async () => {
    const limiter = charger();
    const check = createSubscriptionCheck({
      schema: () => schema,
      maxComplexity: 100,
      costLimit: 100,
      costTtlMs: 60_000,
      charger: limiter as never,
    });
    await expect(check(input('subscription { tick items }'))).resolves.toBeUndefined();
    expect(limiter.charge).toHaveBeenCalledWith(
      expect.objectContaining({
        throttler: 'graphql',
        scope: 'cost',
        tracker: 'user:u-1',
        limit: 100,
      }),
      2,
    );
  });

  it('rejects a fully limited subscription with RATE_LIMITED and retryAfterSeconds', async () => {
    const check = createSubscriptionCheck({
      schema: () => schema,
      maxComplexity: 100,
      costLimit: 1,
      costTtlMs: 60_000,
      charger: charger(true) as never,
    });
    const errors = await check(input('subscription { tick }', undefined));
    expect(errors?.[0]?.extensions).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 9 });
  });

  it('an unbound ref lets everything through', async () => {
    await expect(
      new SubscriptionGuardRef().run(input('subscription { tick }')),
    ).resolves.toBeUndefined();
  });
});
```

`libs/graphql/src/context/graphql-context.factory.spec.ts` already exists and already imports `IncomingMessage`,
`describe/expect/it`, `GqlWsConnectionContext` and `buildWsRequest`. Add only
`import { createClientIpResolver } from '@platform/redis';` to its imports, and append:

```ts
const ctx = (forwardedFor: string): GqlWsConnectionContext =>
  ({
    connectionParams: {},
    extra: {
      request: {
        socket: { remoteAddress: '10.0.0.5' },
        headers: { 'x-forwarded-for': forwardedFor },
        url: '/graphql',
      } as unknown as IncomingMessage,
    },
  }) as GqlWsConnectionContext;

describe('buildWsRequest client IP', () => {
  it('uses the socket address by default (X-Forwarded-For ignored)', () => {
    expect(buildWsRequest(ctx('1.2.3.4')).ip).toBe('10.0.0.5');
  });
  it('honours TRUST_PROXY through the resolver', () => {
    expect(buildWsRequest(ctx('6.6.6.6, 1.2.3.4'), createClientIpResolver(['10.0.0.0/8'])).ip).toBe(
      '1.2.3.4',
    );
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**
      `npx vitest run --project graphql src/subscriptions src/context`. Expected: FAIL (the module is missing, and
      `buildWsRequest` ignores a second argument).

- [ ] **Step 3: Implement.**

`libs/graphql/src/subscriptions/subscription-guard.ts`:

```ts
import { Inject, Injectable, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import {
  type GraphqlConfig,
  graphqlConfig,
  type ThrottleConfig,
  throttleConfig,
} from '@platform/config';
import { authenticatedUserId, RateLimitCharger, THROTTLER } from '@platform/redis';
import { type DocumentNode, GraphQLError, type GraphQLSchema } from 'graphql';
import {
  isIntrospectionOnly,
  measureComplexity,
  QUERY_TOO_COMPLEX,
} from '../plugins/complexity.plugin.js';

export interface SubscriptionCheckInput {
  document: DocumentNode;
  operationName?: string | null | undefined;
  variables?: Record<string, unknown> | undefined;
  user: unknown;
  ip: string | undefined;
}

export type SubscriptionCheck = (
  input: SubscriptionCheckInput,
) => Promise<readonly GraphQLError[] | undefined>;

/** Filled at bootstrap (the schema exists only then); unbound → every subscription passes. */
export class SubscriptionGuardRef {
  private check: SubscriptionCheck | undefined;

  bind(check: SubscriptionCheck): void {
    this.check = check;
  }

  async run(input: SubscriptionCheckInput): Promise<readonly GraphQLError[] | undefined> {
    return this.check === undefined ? undefined : this.check(input);
  }
}

/** The graphql-ws twin of ComplexityPlugin + OperationRateLimitPlugin (one charge per subscribe). */
export function createSubscriptionCheck(deps: {
  schema: () => GraphQLSchema;
  maxComplexity: number;
  costLimit: number;
  costTtlMs: number;
  charger: RateLimitCharger | undefined;
}): SubscriptionCheck {
  return async (input) => {
    if (isIntrospectionOnly(input.document, input.operationName)) return undefined;
    const complexity = measureComplexity({
      schema: deps.schema(),
      document: input.document,
      operationName: input.operationName,
      variables: input.variables,
    });
    if (complexity !== undefined && complexity > deps.maxComplexity) {
      return [
        new GraphQLError(
          `Query is too complex: ${complexity}. Maximum allowed: ${deps.maxComplexity}`,
          {
            extensions: { code: QUERY_TOO_COMPLEX, complexity, maxComplexity: deps.maxComplexity },
          },
        ),
      ];
    }
    if (deps.charger === undefined) return undefined;
    const userId = authenticatedUserId(input.user);
    const { record } = await deps.charger.charge(
      {
        throttler: THROTTLER.GRAPHQL,
        scope: 'cost',
        tracker: userId ? `user:${userId}` : `ip:${input.ip ?? 'unknown'}`,
        limit: deps.costLimit,
        ttlMs: deps.costTtlMs,
        blockMs: deps.costTtlMs,
      },
      Math.max(1, complexity ?? 1),
    );
    if (!record.isBlocked) return undefined;
    return [
      new GraphQLError('Too many requests. Please retry later.', {
        extensions: {
          code: 'RATE_LIMITED',
          status: 429,
          retryAfterSeconds: record.timeToBlockExpire,
        },
      }),
    ];
  };
}

@Injectable()
export class SubscriptionGuardBinder implements OnApplicationBootstrap {
  constructor(
    private readonly ref: SubscriptionGuardRef,
    private readonly schemaHost: GraphQLSchemaHost,
    @Inject(graphqlConfig.KEY) private readonly graphql: GraphqlConfig,
    @Inject(throttleConfig.KEY) private readonly limits: ThrottleConfig,
    @Optional() @Inject(RateLimitCharger) private readonly charger?: RateLimitCharger,
  ) {}

  onApplicationBootstrap(): void {
    this.ref.bind(
      createSubscriptionCheck({
        schema: () => this.schemaHost.schema,
        maxComplexity: this.graphql.maxComplexity,
        costLimit: this.limits.graphqlCostLimit,
        costTtlMs: this.limits.graphqlTtlMs,
        charger: this.charger,
      }),
    );
  }
}
```

`libs/graphql/src/context/graphql-context.factory.ts`:

- import `type ClientIpResolver` from `@platform/redis`;
- `export function buildWsRequest(ctx: GqlWsConnectionContext): GqlRequest {` →
  `export function buildWsRequest(ctx: GqlWsConnectionContext, clientIp: ClientIpResolver = (request) => request?.socket?.remoteAddress): GqlRequest {`;
- `const ip = upgrade?.socket.remoteAddress;` → `const ip = clientIp(upgrade);`;
- `createGraphqlContext` gains a second parameter `clientIp?: ClientIpResolver` and passes it on:
  `buildWsRequest(requestOrWsContext, clientIp)`.

`libs/graphql/src/apollo-config.factory.ts`:

- `ApolloConfigDeps` gains `subscriptionGuard?: SubscriptionGuardRef | undefined;`;
- import `parse, type DocumentNode` from `graphql`, `createClientIpResolver` from `@platform/redis`,
  `buildWsRequest` from `./context/graphql-context.factory.js`, and `type SubscriptionGuardRef` from
  `./subscriptions/subscription-guard.js`;
- in `createApolloDriverConfig`, add `const clientIp = createClientIpResolver(app.trustProxy);` and change
  `context: createGraphqlContext(loaders),` to `context: createGraphqlContext(loaders, clientIp),`;
- in `subscriptions['graphql-ws']`, add after `onClose`:

```ts
        // Apollo plugins never see graphql-ws operations: run the same complexity check and the
        // per-operation cost budget here. Returning errors rejects the subscription.
        onSubscribe: async (ctx, _id, payload) => {
          if (!isWsContext(ctx) || deps.subscriptionGuard === undefined) return undefined;
          let document: DocumentNode;
          try {
            document = parse(payload.query);
          } catch {
            return undefined; // graphql-ws reports the syntax error itself
          }
          const req = buildWsRequest(ctx, clientIp);
          return deps.subscriptionGuard.run({
            document,
            operationName: payload.operationName,
            variables: payload.variables ?? undefined,
            user: req.user,
            ip: req.ip,
          });
        },
```

If Nest's `ApolloDriverConfig` types the callback parameters loosely (as it does for `onConnect`, see the comment at
`:65`), keep the `isWsContext(ctx)` guard and read `payload` as `{ query: string; operationName?: string | null; variables?: Record<string, unknown> | null }`.

`libs/graphql/src/graphql.module.ts`:

- in `forRootAsync`, create `const subscriptionGuard = new SubscriptionGuardRef();`;
- add `subscriptionGuard,` to the object passed to `createApolloDriverConfig`;
- add `ConfigModule.forFeature(throttleConfig)` to the module `imports` if C9 did not already;
- `providers` gains `{ provide: SubscriptionGuardRef, useValue: subscriptionGuard }, SubscriptionGuardBinder`.

`libs/graphql/src/index.ts`: export `SubscriptionGuardRef`, `SubscriptionGuardBinder`, `createSubscriptionCheck` and the
two types.

- [ ] **Step 4: Run; expect PASS.** `npx vitest run --project graphql`. Expected: PASS.

- [ ] **Step 5: Wider checks.** `npx biome check --write libs/graphql/src`, `bun run check`,
      `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off; both boot graphql-ws). Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add libs/graphql/src
git commit -m "feat(graphql): run the complexity check and per-operation limit on graphql-ws" \
  -m "graphql-ws onSubscribe now rejects subscriptions over GRAPHQL_MAX_COMPLEXITY (QUERY_TOO_COMPLEX) or beyond the graphql cost budget (RATE_LIMITED), and the graphql-ws request IP follows TRUST_PROXY."
```

### Task C11: Connection caps — concurrent sockets per user, handshakes per IP (C-9)

**Wave:** 2, after C10, in lane `c-tenant`. Also wait for any in-flight B4 work on
`domains/notifications/src/presentation/ws/notifications.gateway.ts` (B4-4 tenant rooms) and
`libs/graphql/src/auth/subscription-auth.ts` (F18 revocation). This task edits the same handshake and close
callbacks.

**Why:** Spec §11 asks for caps on concurrent sockets per user and on handshakes per IP, for both Socket.IO and
graphql-ws. Today a single user can open unlimited sockets, and handshakes are not limited at all: the Socket.IO
handshake middleware (`notifications.gateway.ts` `afterInit`) and graphql-ws `onConnect` run outside every guard.

**Design:**

- Handshakes per IP: a `ws-handshake` bucket (`THROTTLE_WS_HANDSHAKE_LIMIT` per `THROTTLE_WS_HANDSHAKE_TTL_MS`) on the
  `RateLimitCharger`, keyed by the proxy-aware IP.
- Concurrent sockets per user: an atomic Redis counter (Lua `appConnCount`). It goes +1 on accept (refused past
  `THROTTLE_WS_SOCKETS_PER_USER`) and −1 on close.
- The key TTL (`THROTTLE_WS_SOCKET_TTL_MS`, default 1 h, refreshed on every change) bounds leaks from crashed
  replicas.
- Both fail open when Redis is unusable (budgets).

**Files:**

- Create: `libs/redis/src/throttler/conn-count.command.ts` (Lua + command name, like `throttle.command.ts`),
  `libs/redis/src/throttler/connection-caps.ts`, `libs/redis/src/throttler/connection-caps.spec.ts`
- Modify: `libs/redis/src/testing/in-memory-redis.ts` (emulate `appConnCount`), `libs/redis/src/throttler/app-throttler.module.ts`,
  `libs/redis/src/throttler/throttle.constants.ts`, `libs/redis/src/index.ts`
- Modify: `libs/config/src/namespaces/throttle.config.ts`, `libs/config/src/namespaces/namespaces.spec.ts`, root `.env.example`
- Modify: `libs/graphql/src/auth/subscription-auth.ts`, `libs/graphql/src/auth/subscription-auth.spec.ts`, `libs/graphql/src/graphql.module.ts`
- Modify: `domains/notifications/src/presentation/ws/notifications.gateway.ts`, `domains/notifications/src/presentation/ws/notifications.gateway.spec.ts`
  (create it if absent)

**Interfaces:**

- Produces:

  ```ts
  THROTTLER.WS_HANDSHAKE = 'ws-handshake';
  export const CONN_COUNT_COMMAND = 'appConnCount';
  export type HandshakeVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };
  export class ConnectionCaps {
    admitHandshake(ip: string | undefined): Promise<HandshakeVerdict>;
    acquireSocket(userId: string): Promise<boolean>; // false → cap reached
    releaseSocket(userId: string): Promise<void>;
  }
  export const TOO_MANY_CONNECTIONS = 'TOO_MANY_CONNECTIONS'; // problem code (429) for the per-user cap
  // ThrottleConfig gains wsHandshakeLimit (THROTTLE_WS_HANDSHAKE_LIMIT, 30), wsHandshakeTtlMs (THROTTLE_WS_HANDSHAKE_TTL_MS, 60000),
  //   wsSocketsPerUser (THROTTLE_WS_SOCKETS_PER_USER, 10), wsSocketTtlMs (THROTTLE_WS_SOCKET_TTL_MS, 3600000)
  // GraphqlWsAuthOptions gains caps?: ConnectionCaps; clientIp?: ClientIpResolver
  ```

- [ ] **Step 1: Write the failing tests.**

`libs/redis/src/throttler/connection-caps.spec.ts`:

```ts
import { redisConfig, throttleConfig } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { ConnectionCaps } from './connection-caps.js';
import { RateLimitCharger } from './rate-limit-charger.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

function setup(env: Record<string, string> = {}) {
  const redis = new InMemoryRedis();
  const keys = new RedisKeyService(redisConfig.parse({}));
  const storage = new RedisThrottlerStorage(redis.asRedis(), keys);
  const caps = new ConnectionCaps(
    redis.asRedis(),
    keys,
    throttleConfig.parse(env),
    new RateLimitCharger(storage),
  );
  return { redis, caps };
}

describe('ConnectionCaps', () => {
  it('caps concurrent sockets per user and frees a slot on release', async () => {
    const { caps } = setup({ THROTTLE_WS_SOCKETS_PER_USER: '2' });
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect(await caps.acquireSocket('u-1')).toBe(false);
    expect(await caps.acquireSocket('u-2')).toBe(true);
    await caps.releaseSocket('u-1');
    expect(await caps.acquireSocket('u-1')).toBe(true);
  });

  it('never goes below zero on extra releases', async () => {
    const { caps } = setup({ THROTTLE_WS_SOCKETS_PER_USER: '1' });
    await caps.releaseSocket('u-1');
    await caps.releaseSocket('u-1');
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect(await caps.acquireSocket('u-1')).toBe(false);
  });

  it('limits handshakes per IP with a retry-after', async () => {
    const { caps } = setup({ THROTTLE_WS_HANDSHAKE_LIMIT: '2' });
    expect(await caps.admitHandshake('1.2.3.4')).toEqual({ ok: true });
    expect(await caps.admitHandshake('1.2.3.4')).toEqual({ ok: true });
    const refused = await caps.admitHandshake('1.2.3.4');
    expect(refused.ok).toBe(false);
    expect(await caps.admitHandshake('5.6.7.8')).toEqual({ ok: true });
  });

  it('fails open when Redis is down', async () => {
    const { redis, caps } = setup({
      THROTTLE_WS_SOCKETS_PER_USER: '1',
      THROTTLE_WS_HANDSHAKE_LIMIT: '1',
    });
    redis.simulateOutage();
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect((await caps.admitHandshake('1.2.3.4')).ok).toBe(true);
    await expect(caps.releaseSocket('u-1')).resolves.toBeUndefined();
  });
});
```

`RedisKeyService` takes the parsed `redis` namespace (`new RedisKeyService(redisConfig.parse({}))`, as in
`redis-throttler.storage.spec.ts:9`).

In `libs/graphql/src/auth/subscription-auth.spec.ts`, append this `describe`. It uses the spec's existing helpers
`user(overrides?)` (an `AuthUser` fixture, `:14-24`) and `wsContext(connectionParams?)` (`:28-32`, no `request`, so
the client IP is `undefined`), and its `vi` import:

```ts
describe('connection caps (C-9)', () => {
  const jane = user();

  it('refuses the connection past the per-user socket cap, and releases the slot on close', async () => {
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: true as const })),
      acquireSocket: vi.fn(async () => false),
      releaseSocket: vi.fn(async () => undefined),
    };
    const handlers = createGraphqlWsAuthHandlers(async () => jane, { caps });
    await expect(handlers.onConnect(wsContext({ token: 'ok' }))).resolves.toBe(false);
    expect(caps.admitHandshake).toHaveBeenCalledWith(undefined);
    caps.acquireSocket.mockResolvedValue(true);
    const ctx = wsContext({ token: 'ok' });
    await expect(handlers.onConnect(ctx)).resolves.toBe(true);
    handlers.onClose(ctx);
    await vi.waitFor(() => expect(caps.releaseSocket).toHaveBeenCalledWith(jane.id));
  });

  it('refuses a connection from an IP over the handshake limit before authenticating', async () => {
    const authenticate = vi.fn(async () => jane);
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: false as const, retryAfterSeconds: 5 })),
      acquireSocket: vi.fn(async () => true),
      releaseSocket: vi.fn(async () => undefined),
    };
    const handlers = createGraphqlWsAuthHandlers(authenticate, { caps });
    await expect(handlers.onConnect(wsContext({ token: 'ok' }))).resolves.toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
    expect(caps.acquireSocket).not.toHaveBeenCalled();
  });
});
```

`domains/notifications/src/presentation/ws/notifications.gateway.spec.ts` already exists (it imports `describe`,
`expect`, `it`, `vi` and `NotificationsGateway`). Append only the following `const socket` helper and `describe`
(no new imports; if `socket` is already a top-level name there, call the helper `capsSocket`):

```ts
const socket = () => ({
  data: {} as Record<string, unknown>,
  handshake: { auth: { token: 't' }, headers: {}, address: '1.2.3.4' },
  request: { socket: { remoteAddress: '1.2.3.4' }, headers: {} },
  join: vi.fn(),
});

describe('NotificationsGateway connection caps', () => {
  const tokens = {
    verifyAccessToken: vi.fn(async () => ({ jti: 'j', exp: Math.floor(Date.now() / 1000) + 60 })),
    toAuthUser: vi.fn(() => ({ id: 'u-1', exp: Math.floor(Date.now() / 1000) + 60 })),
  };
  const denylist = { isDenied: vi.fn(async () => false) };

  it('refuses a handshake over the per-IP limit with a 429 problem (connect_error data)', async () => {
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: false as const, retryAfterSeconds: 7 })),
      acquireSocket: vi.fn(),
      releaseSocket: vi.fn(),
    };
    const gateway = new NotificationsGateway(
      tokens as never,
      denylist as never,
      {} as never,
      caps as never,
    );
    const error = await gateway.authenticate(socket() as never);
    expect(error?.data).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });

  it('refuses the socket past the per-user cap with TOO_MANY_CONNECTIONS', async () => {
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: true as const })),
      acquireSocket: vi.fn(async () => false),
      releaseSocket: vi.fn(),
    };
    const gateway = new NotificationsGateway(
      tokens as never,
      denylist as never,
      {} as never,
      caps as never,
    );
    const error = await gateway.authenticate(socket() as never);
    expect(error?.data).toMatchObject({ status: 429, code: 'TOO_MANY_CONNECTIONS' });
  });
});
```

The fakes cover exactly what `authenticateSocket` (`libs/auth/src/ws/socket-auth.ts:45-63`) calls at `9600510`:
`tokens.verifyAccessToken(raw)`, `denylist.isDenied(jti)`, `tokens.toAuthUser(claims)`. If B2 changed that function,
fake its new calls the same way.

- [ ] **Step 2: Run; expect FAIL.**
      `npx vitest run --project redis src/throttler/connection-caps.spec.ts`, `npx vitest run --project graphql src/auth`,
      `npx vitest run --project notifications src/presentation/ws`. Expected: FAIL (`ConnectionCaps` is missing, and
      neither handshake path checks caps).

- [ ] **Step 3: Implement.**

`libs/redis/src/throttler/conn-count.command.ts` (dependency-free, so `in-memory-redis.ts` can import it the way
it imports `throttle.command.ts`):

```ts
import type { Result } from 'ioredis';

export const CONN_COUNT_COMMAND = 'appConnCount';

/**
 * KEYS[1] counter. ARGV[1] delta (+1 / -1), ARGV[2] cap, ARGV[3] key ttl ms.
 * Returns { count, admitted (0|1) }. Never below 0; refused increments are rolled back.
 */
export const CONN_COUNT_SCRIPT = `
local delta = tonumber(ARGV[1])
local n = redis.call('INCRBY', KEYS[1], delta)
if n < 0 then
  redis.call('SET', KEYS[1], 0)
  n = 0
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
if delta > 0 and n > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], delta)
  return { n - delta, 0 }
end
return { n, 1 }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    appConnCount(
      key: string,
      delta: number,
      cap: number,
      ttlMs: number,
    ): Result<[number, number], Context>;
  }
}
```

`libs/redis/src/throttler/connection-caps.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { normalizeIp } from '@nestjs/throttler';
import { type ThrottleConfig, throttleConfig } from '@platform/config';
import type { Redis } from 'ioredis';
import { hashTag } from '../keys/key.util.js';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { REDIS_CLIENT } from '../redis.constants.js';
import { CONN_COUNT_COMMAND, CONN_COUNT_SCRIPT } from './conn-count.command.js';
import { RateLimitCharger } from './rate-limit-charger.js';
import { GLOBAL_SCOPE, THROTTLER } from './throttle.constants.js';

export const TOO_MANY_CONNECTIONS = 'TOO_MANY_CONNECTIONS';

export type HandshakeVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Socket.IO and graphql-ws connection caps (spec §11). Both fail open when Redis is unusable. */
@Injectable()
export class ConnectionCaps {
  private readonly logger = new Logger(ConnectionCaps.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly keys: RedisKeyService,
    @Inject(throttleConfig.KEY) private readonly limits: ThrottleConfig,
    private readonly charger: RateLimitCharger,
  ) {
    redis.defineCommand(CONN_COUNT_COMMAND, { numberOfKeys: 1, lua: CONN_COUNT_SCRIPT });
  }

  async admitHandshake(ip: string | undefined): Promise<HandshakeVerdict> {
    const { wsHandshakeLimit, wsHandshakeTtlMs } = this.limits;
    try {
      const { record } = await this.charger.charge({
        throttler: THROTTLER.WS_HANDSHAKE,
        scope: GLOBAL_SCOPE,
        tracker: ip ? `ip:${normalizeIp(ip, 64)}` : 'ip:unknown',
        limit: wsHandshakeLimit,
        ttlMs: wsHandshakeTtlMs,
        blockMs: wsHandshakeTtlMs,
      });
      return record.isBlocked
        ? { ok: false, retryAfterSeconds: record.timeToBlockExpire }
        : { ok: true };
    } catch (error) {
      this.warn(error);
      return { ok: true };
    }
  }

  async acquireSocket(userId: string): Promise<boolean> {
    return (await this.count(userId, 1)) !== 0;
  }

  async releaseSocket(userId: string): Promise<void> {
    await this.count(userId, -1);
  }

  /** 1 = admitted (or failed open), 0 = refused. */
  private async count(userId: string, delta: 1 | -1): Promise<0 | 1> {
    if (this.redis.status !== 'ready') return 1;
    const key = this.keys.key('wsconn', hashTag(userId));
    try {
      const [, admitted] = await this.redis.appConnCount(
        key,
        delta,
        this.limits.wsSocketsPerUser,
        this.limits.wsSocketTtlMs,
      );
      return admitted === 1 ? 1 : 0;
    } catch (error) {
      this.warn(error);
      return 1;
    }
  }

  private warn(error: unknown): void {
    this.logger.warn(
      `connection caps bypassed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

`libs/redis/src/testing/in-memory-redis.ts`: add the model and register it in `EMULATED_SCRIPTS`:

```ts
/** JS model of `CONN_COUNT_SCRIPT` (connection-caps.ts), statement by statement. */
function connCountModel(redis: InMemoryRedis, keys: string[], args: string[]): [number, number] {
  const [key = ''] = keys;
  const [delta = 0, cap = 0, ttl = 0] = args.map(Number);
  let n = Number(redis.getSync(key) ?? 0) + delta;
  if (n < 0) n = 0;
  redis.setSync(key, String(n));
  redis.pexpireSync(key, ttl);
  if (delta > 0 && n > cap) {
    redis.setSync(key, String(n - delta));
    redis.pexpireSync(key, ttl);
    return [n - delta, 0];
  }
  return [n, 1];
}
```

`[CONN_COUNT_COMMAND, connCountModel],` goes into the `EMULATED_SCRIPTS` map. Import `CONN_COUNT_COMMAND` from
`../throttler/conn-count.command.js`. Check that `ScriptImplementation`'s return type accepts `[number, number]`; widen it
to `unknown` if needed.

Other changes:

- `throttle.constants.ts`: add `WS_HANDSHAKE: 'ws-handshake',` to `THROTTLER` (not to `RATE_LIMIT_THROTTLERS`).
- `throttle.config.ts`:
  - add `THROTTLE_WS_HANDSHAKE_LIMIT: zInt(30, { min: 1 })`, `THROTTLE_WS_HANDSHAKE_TTL_MS: zInt(60_000, { min: 1 })`,
    `THROTTLE_WS_SOCKETS_PER_USER: zInt(10, { min: 1 })`, `THROTTLE_WS_SOCKET_TTL_MS: zInt(3_600_000, { min: 1_000 })`;
  - map them to `wsHandshakeLimit`, `wsHandshakeTtlMs`, `wsSocketsPerUser`, `wsSocketTtlMs`;
  - extend the `namespaces.spec.ts` `toEqual` with these four defaults.
- `app-throttler.module.ts`: `ConnectionCaps` goes into `providers` and `exports`.
- `index.ts`: export `CONN_COUNT_COMMAND`, `CONN_COUNT_SCRIPT` (from `./throttler/conn-count.command.js`),
  `ConnectionCaps`, `type HandshakeVerdict` and `TOO_MANY_CONNECTIONS`.

`libs/graphql/src/auth/subscription-auth.ts`:

- `GraphqlWsAuthOptions` gains `caps?: Pick<ConnectionCaps, 'admitHandshake' | 'acquireSocket' | 'releaseSocket'>;`
  and `clientIp?: ClientIpResolver;` (types from `@platform/redis`).
- Add `const acquired = new WeakMap<GqlWsExtra, string>();` next to `expiryTimers`.
- In `onConnect`, first statement:

```ts
const ip = (options.clientIp ?? ((r) => r?.socket?.remoteAddress))(ctx.extra.request);
if (options.caps !== undefined && !(await options.caps.admitHandshake(ip)).ok) return false;
```

- After `ctx.extra.user = user;`:

```ts
if (options.caps !== undefined) {
  if (!(await options.caps.acquireSocket(user.id))) return false;
  acquired.set(ctx.extra, user.id);
}
```

- In `onClose`, add:

```ts
const userId = acquired.get(ctx.extra);
acquired.delete(ctx.extra);
if (userId !== undefined) void options.caps?.releaseSocket(userId);
```

graphql-ws answers `false` from `onConnect` with close code 4403. Document in the function's doc comment that a
cap refusal looks the same as an auth refusal to the client.

`libs/graphql/src/graphql.module.ts`:

- add `{ token: ConnectionCaps, optional: true }` to `GraphQLModule.forRootAsync({ inject: [...] })`, and the factory
  parameter `caps: ConnectionCaps | undefined`;
- pass `createGraphqlWsAuthHandlers(createSubscriptionAuthenticator(tokens, denylist), { requireAuth: …, ...(caps ? { caps } : {}), clientIp: createClientIpResolver(app.trustProxy) })`.

`domains/notifications/src/presentation/ws/notifications.gateway.ts`:

- Add a fourth constructor parameter
  `@Optional() @Inject(ConnectionCaps) private readonly caps?: ConnectionCaps` (explicit token: an optional
  parameter must not rely on emitted metadata). Import `Inject` and `Optional` from `@nestjs/common`;
  `ConnectionCaps`, `createClientIpResolver`, `TOO_MANY_CONNECTIONS` from `@platform/redis`;
  `DEFAULT_PROBLEM_TYPE_BASE_URL` and `type ProblemDetails` from `@platform/common` (next to `toProblemDetails`);
  `type AppConfig, appConfig` from `@platform/config` (already a dependency of `@domain/notifications`).
  Also add a property-injected `@Optional() @Inject(appConfig.KEY) private readonly app?: AppConfig;`, so the
  client IP follows `TRUST_PROXY`.
- In `authenticate(socket)`, as the first statement inside `try {` (before `socket.data.user = await authenticateSocket(...)`):

```ts
const ip = createClientIpResolver(this.app?.trustProxy ?? false)(socket.request);
const verdict = (await this.caps?.admitHandshake(ip)) ?? { ok: true as const };
if (!verdict.ok) {
  return this.refuse('RATE_LIMITED', 'Too many connection attempts. Please retry later.');
}
```

- After the `socket.data.user = await authenticateSocket(…);` statement, before `return undefined;`:

```ts
if (this.caps !== undefined) {
  if (!(await this.caps.acquireSocket(socket.data.user.id))) {
    return this.refuse(TOO_MANY_CONNECTIONS, 'Too many open connections for this user.');
  }
  socket.data.capAcquired = true;
}
```

- In `handleDisconnect(client)`, add:
  `if (client.data.capAcquired === true && client.data.user) void this.caps?.releaseSocket(client.data.user.id);`
- `NotificationsSocketData` (`notifications.gateway.ts:41-43`) gains `capAcquired?: boolean;`.
- Add the helper. It builds the same `ProblemDetails` shape `toProblemDetails` produces (`type` =
  `DEFAULT_PROBLEM_TYPE_BASE_URL` + kebab code), carried as `connect_error` data exactly like the existing catch
  branch (`Object.assign(new Error(...), { data: problem })`):

```ts
  /** A 429 handshake refusal, as a problem document in `connect_error` data. */
  private refuse(code: string, detail: string): ExtendedError {
    const problem: ProblemDetails = {
      type: `${DEFAULT_PROBLEM_TYPE_BASE_URL}${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Too Many Requests',
      status: 429,
      code,
      detail,
    };
    this.logger.debug(`Refused socket handshake: ${code}`);
    return Object.assign(new Error(detail), { data: problem });
  }
```

Root `.env.example`, throttle section:

```
# WebSockets (Socket.IO and graphql-ws): handshakes per client IP, and concurrent sockets per user.
# THROTTLE_WS_HANDSHAKE_LIMIT=30
# THROTTLE_WS_HANDSHAKE_TTL_MS=60000
# THROTTLE_WS_SOCKETS_PER_USER=10
# Safety TTL of the per-user socket counter (bounds leaks from crashed replicas).
# THROTTLE_WS_SOCKET_TTL_MS=3600000
```

- [ ] **Step 4: Run; expect PASS.**
      `npx vitest run --project redis --project graphql --project notifications --project config`. Expected: PASS.

- [ ] **Step 5: Wider checks.** `npx biome check --write libs/redis libs/graphql/src libs/config/src domains/notifications/src`,
      `bun run check`, `node scripts/check-env-example.mjs`, `npx vitest run --project monolith:e2e --project gateway:e2e`
      (sandbox off). Expected: PASS. If E-1's real Socket.IO spec (E plan) has landed, run it too:
      `npx vitest run --project notifications` / the path E-1 created.

- [ ] **Step 6: Commit.**

```bash
git add libs/redis libs/graphql/src libs/config/src domains/notifications/src .env.example
git commit -m "feat(redis,graphql,notifications): cap sockets per user and ws handshakes per ip" \
  -m "ConnectionCaps (THROTTLE_WS_*) refuses Socket.IO handshakes with a 429 problem and graphql-ws connections with 4403 past the per-IP handshake budget or the per-user concurrent socket cap; both fail open without Redis."
```

### Task C12: Wave-2 e2e proof and docs (C-11b)

**Wave:** 2, after C11, in lane `c-tenant`.

**Files:**

- Modify: `apps/monolith/test/rate-limit.e2e-spec.ts`, `apps/gateway/test/rate-limit.e2e-spec.ts`
- Modify: `docs/CONFIGURATION.md`, `docs/API.md`, `docs/SECURITY.md`, `libs/redis/README.md`, `libs/graphql/README.md`,
  `libs/config/README.md`, `docs/TESTING.md`, `README.md:63`

**Interfaces:**

- Consumes C8-C11.
- Consumes `signTestAccessToken(claims, { config? })` (`@platform/auth/testing`). After B2-18 it accepts the active
  tenant. Check its claims type and pass `tenantId` (or `tid`) the way B2 named it.

- [ ] **Step 1: Add the e2e cases.**
- In `apps/gateway/test/rate-limit.e2e-spec.ts`, add `THROTTLE_TENANT_LIMIT: '3'` to the hoisted env and add the
  tenant case below. Use `e2e.app.inject` for `inject`, and import `bearer`.
- In `apps/monolith/test/rate-limit.e2e-spec.ts`, add `THROTTLE_GRAPHQL_COST_LIMIT: '5'` to the hoisted env and add
  the GraphQL case.

Keeping the two cases in separate specs means neither budget interferes with the other.

```ts
// gateway spec
it('two members of one tenant share the tenant budget; another tenant is unaffected', async () => {
  const alice = await signTestAccessToken({
    id: generateId(),
    email: 'a@t1.io',
    tenantId: 't-1',
    roles: ['member'],
  });
  const bob = await signTestAccessToken({
    id: generateId(),
    email: 'b@t1.io',
    tenantId: 't-1',
    roles: ['member'],
  });
  const carol = await signTestAccessToken({
    id: generateId(),
    email: 'c@t2.io',
    tenantId: 't-2',
    roles: ['member'],
  });
  const me = (token: string) =>
    inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(token) });
  for (const token of [alice.token, bob.token, alice.token])
    expect((await me(token)).statusCode).not.toBe(429);
  expectProblem(await me(bob.token), 429, 'RATE_LIMITED');
  expect((await me(carol.token)).statusCode).not.toBe(429);
});

// monolith spec
it('GraphQL is limited per operation by cost and answers HTTP 429', async () => {
  const dana = await signTestAccessToken({
    id: generateId(),
    email: 'd@t3.io',
    tenantId: 't-3',
    roles: ['member'],
  });
  const op = () => inject(graphql('query Me { me { id } }', undefined, bearer(dana.token)));
  const first = await op();
  expect(first.headers['ratelimit-policy']).toContain('"graphql:cost";q=5;w=60');
  let last = first;
  for (let i = 0; i < 6 && last.statusCode !== 429; i += 1) last = await op();
  expect(last.statusCode).toBe(429);
  expect(
    last.json<{ errors: { extensions: { code: string } }[] }>().errors[0]?.extensions.code,
  ).toBe('RATE_LIMITED');
  expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
});
```

`me` is the existing GraphQL query (`domains/identity/src/presentation/graphql/users.resolver.ts:25`); `me { id }`
costs 2, so the 5-point budget refuses the 3rd call (6 > 5), well within 6 calls. The charge happens in
`didResolveOperation`, before the resolver, so it does not matter whether the token-only user exists. Import `bearer` and `graphql` from `./support/http.js`, `signTestAccessToken` from `@platform/auth/testing`
and `generateId` from `@platform/common`. Do not use an introspection-only query: those are exempt. In the gateway
case, `/v1/auth/me` may answer 404 for a token-only user (`FakeUsersPort`). That is fine: the test only asserts 429
versus not-429, and the guard answers 429 before the handler runs.

- [ ] **Step 2: Run.** `npx vitest run --project monolith:e2e --project gateway:e2e` (sandbox off). Expected: PASS.

- [ ] **Step 3: Docs.**
- `docs/CONFIGURATION.md` throttle table: add rows for `THROTTLE_TENANT_TTL_MS` (60000), `THROTTLE_TENANT_LIMIT` (3000),
  `THROTTLE_GRAPHQL_TTL_MS` (60000), `THROTTLE_GRAPHQL_COST_LIMIT` (20000), `THROTTLE_WS_HANDSHAKE_LIMIT` (30),
  `THROTTLE_WS_HANDSHAKE_TTL_MS` (60000), `THROTTLE_WS_SOCKETS_PER_USER` (10) and `THROTTLE_WS_SOCKET_TTL_MS` (3600000).
  Use the descriptions from the `.env.example` comments.
- `docs/API.md` rate-limiting bullet: add the `tenant` budget, "GraphQL: once per operation, weighted by complexity
  (`THROTTLE_GRAPHQL_COST_LIMIT`), HTTP 429 `RATE_LIMITED`; graphql-ws subscriptions run the same complexity check
  and cost budget", and "WebSockets: `THROTTLE_WS_HANDSHAKE_LIMIT` handshakes per IP and `THROTTLE_WS_SOCKETS_PER_USER`
  concurrent sockets per user (Socket.IO `connect_error` 429 `RATE_LIMITED` / `TOO_MANY_CONNECTIONS`; graphql-ws 4403)".
  Add `TOO_MANY_CONNECTIONS` (429) to the generic codes table.
- `docs/SECURITY.md`: add the tenant, GraphQL-cost and WebSocket rows to the limits table.
- `libs/redis/README.md`: add `tenant`, `graphql`, `ws-handshake` to the Throttlers table, plus rows for
  `RateLimitCharger` and `ConnectionCaps`.
- `libs/graphql/README.md`: document `OperationRateLimitPlugin` and the graphql-ws `onSubscribe` check.
- `libs/config/README.md` throttle row: add the new variables.
- `docs/TESTING.md`: mention the tenant and GraphQL cases.
- `README.md:63`: refresh the counts from `bun run test`.
  Run `npx prettier --write` on every edited Markdown file.

- [ ] **Step 4: Wider checks.** `bun run check`, `bun run test` (sandbox off), `node scripts/check-env-example.mjs`,
      `bun run build`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/monolith/test/rate-limit.e2e-spec.ts apps/gateway/test/rate-limit.e2e-spec.ts docs/*.md README.md libs/redis/README.md libs/graphql/README.md libs/config/README.md
git commit -m "test(monolith,gateway): prove the tenant and GraphQL limits end to end and document wave 2" \
  -m "Covers the shared tenant budget and the per-operation GraphQL cost budget with HTTP 429; documents THROTTLE_TENANT_*, THROTTLE_GRAPHQL_* and THROTTLE_WS_*."
```

## Spec coverage

| Inventory item                                                | Spec            | Task(s)                                                                                   | Wave   |
| ------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------- | ------ |
| C-1 scope-based generateKey (F17)                             | §11 Library     | C1 (+ C2 shares the `auth` scope across REST and GraphQL)                                 | 1      |
| C-4 named policy registry, `@RateLimit`                       | §11 Policies    | C1                                                                                        | 1      |
| C-3 `auth` throttler, sha256(email)+IP, lockout               | §1, §11         | C2                                                                                        | 1      |
| C-2 `ip` (pre-auth, proxy-aware WS) and `user`                | §11 Throttlers  | C1 (`user`), C3 (`ip`, WS IP), C10 (graphql-ws IP)                                        | 1 (+2) |
| C-2 `tenant`                                                  | §11 Throttlers  | C8                                                                                        | 2      |
| C-7 IETF headers, also on 429, CORS                           | §11 Responses   | C4                                                                                        | 1      |
| C-10 Redis down: budgets open (metric + timeout), auth closed | §11 Redis down  | C5                                                                                        | 1      |
| C-8 WS errors as acks / `exception`, filter wired             | §11 Responses   | C6                                                                                        | 1      |
| AUDIT-F22 error `details`                                     | inventory       | C6 (code), C7 (API.md)                                                                    | 1      |
| C-5 GraphQL per-operation, cost-weighted, 429                 | §11 GraphQL     | C9                                                                                        | 2      |
| C-6 complexity on graphql-ws                                  | §11 GraphQL     | C10                                                                                       | 2      |
| C-9 socket caps per user, handshakes per IP                   | §11 Connections | C11                                                                                       | 2      |
| C-11 tests for every documented limit                         | §1              | the unit tests in C1-C11, C7 (wave-1 e2e), C12 (wave-2 e2e)                               | 1, 2   |
| G-10 decision metrics (not C)                                 | §12             | hook: `RateLimitGuardBase.recordDecision` (C4); counter `rate_limit_fail_open_total` (C5) | —      |

Execution order: C1 → C2 → C3 → C4 → C5 (lane `c-throttle`) ∥ C6 (lane `c-ws-errors`) → merge both → C7 → (B2 merged)
→ C8 → C9 → C10 → C11 → C12.

## Self-review

- Every inventory item in scope (C-1 to C-11, AUDIT-F22) maps to a task (table above).
- Names used across tasks:
  - `THROTTLER.{IP,USER,TENANT,ROUTE,AUTH,LOCKOUT,GRAPHQL,WS_HANDSHAKE}`, `RATE_LIMIT_THROTTLERS`,
    `RateLimitGuardBase.{bucketFor,charge,recordDecision,policyFor,ipTracker,userTracker,responseOf,isIgnored,enforced}`;
  - `RateLimitBucket`, `RateLimitDecision`, `RateLimitPolicy`, `RateLimitCharger.charge(bucket, weight)`;
  - `RedisThrottlerStorage.{increment,incrementBy,reset}`;
  - `ThrottleConfig.{ttlMs,limit,ipTtlMs,ipLimit,redisTimeoutMs,tenantTtlMs,tenantLimit,graphqlTtlMs,graphqlCostLimit,wsHandshakeLimit,wsHandshakeTtlMs,wsSocketsPerUser,wsSocketTtlMs}`.
- Each later task quotes the code an earlier task produced.
- Keys: every bucket goes through `rateLimitKey(throttler, scope, tracker)`. The GraphQL de-duplication (C9) is
  per request and per throttler, and covers only global scopes.
- Fail modes: `FAIL_CLOSED_THROTTLERS = {auth, lockout}`. `graphql`, `tenant`, `ws-handshake` and the connection
  counter fail open.
- Judgement calls were settled by the controller rulings of 2026-11-09 (see "Plan review"); none are open.

## Plan review (2026-11-09)

Adversarial review (review:c) against the code at `9600510`, the installed packages (`@nestjs/throttler` 6.7.1
`throttler.guard.js`/`ip.js`, `@fastify/proxy-addr` 5.1.1 + `@fastify/forwarded`, `@nestjs/websockets`
`exception-filters-context.js`, `@willsoto/nestjs-prometheus` 6.1.1, `graphql-ws` 6.3.0, `@nestjs/graphql`
`gql-subscription.service.js`), spec §5.3/§7/§11 (unchanged at review time) and the E, G, ledger and sharding plans.
Every commit header was run through `commitlint` (all pass, max 91 chars).

### Changes made

- Controller rulings:
  - `THROTTLE_LIMIT` default 100 → 300: C1 now changes `throttle.config.ts`, adds a failing `namespaces.spec.ts`
    assertion and edits `.env.example`. The later throttle `toEqual`s (C2, C3, C5) and C4's
    `rate-limit-order.spec.ts` headers (`q=300`, `r=299`) follow, as do the C7 docs (CONFIGURATION, API, SECURITY,
    redis/config READMEs, PERFORMANCE `:525`, `docker/k6/script.js`).
  - No deprecated aliases: the C7 CONFIGURATION.md "Renamed (no aliases)" note, the `.env.example` comment, and the
    interface contract all list the removed names.
  - Per-account lockout kept. C7 SECURITY.md now spells out the targeted-lockout trade-off and its mitigations.
  - Interceptor-based reset kept. The boundary was checked against `THROTTLE_SCRIPT` (refuse only when
    `hits > limit`): with threshold N, a correct password on attempt N succeeds and resets, and attempt N+1 after N
    failures is refused. There was no off-by-one in the code, but the wording said "attempts", not "failed
    attempts". C2's "How the lockout learns" section, the `.env.example` comment and the docs now state the exact
    boundary, and C2 adds a storage-level boundary + reset test. The gateway e2e (threshold 3: three 401s, then
    429 with the right password) already pins it end to end.
- Executability:
  - C2: `makeStorage()` did not exist. It is now a local helper over the spec's `keys` constant. C2 also deletes
    the stale `limits` assertion in `app-throttler.module.spec.ts` (`authLimit` no longer exists) and the unused
    `throttleConfig` import, and fixes the contradictory `lockout.js` import instructions.
  - C5: `keys()` → `keys` (an object, not a function). `reset` is given as exact code (timeout, best effort). The
    `SERVICE_UNAVAILABLE` code is confirmed at `domain.exception.ts:156-166`.
  - C6: there is no `filter` variable. The test builds `new AllExceptionsFilter(fakeAdapterHost().host)`, adds the
    `HttpException` import, and is marked as a characterization test (it passes before Step 3).
    `ForbiddenDomainException` → `PermissionDeniedException`, with the import list given.
  - C9/C10/C11: `@Optional()` constructor params typed `RateLimitCharger | undefined` (or `?:` relying on emitted
    metadata) would resolve `Object`, so the plugin, binder and gateway would never get the charger or caps. Each now
    has `@Optional() @Inject(Token)`.
  - C9: the GraphQL once-per-request de-duplication returned early for later root fields even when the first was
    refused (`{ a b }` ran `b` past a blocked budget). It now stores the refusal and re-throws it, with a new unit
    test. The `ConfigModule.forFeature(throttleConfig)` placement (top-level `imports`) is made explicit.
  - C10: `graphql-context.factory.spec.ts` exists. The plan now says to add one import and append the tests.
  - C11: the `subscription-auth.spec.ts` tests are rewritten on the spec's real helpers (`user()`, `wsContext()`).
    `notifications.gateway.spec.ts` exists, so the plan appends to it. The Socket.IO refusal now has one style
    (`ProblemDetails` + `DEFAULT_PROBLEM_TYPE_BASE_URL` + `Object.assign`, like the existing catch). Its insertion
    points are exact, `NotificationsSocketData` is named, and the `RedisKeyService` constructor is stated.
  - C3: `import type { ThrottlerStorage }` (was `import { type … }`), plus the exact monolith `app.module.ts` comment
    rewrite (its old wording mentions `@AuthThrottle` and would fail C7's `rg` gate).
  - C12: `me` already exists (`users.resolver.ts:25`, cost 2). The plan no longer attributes it to B2.
- Coverage and docs:
  - C7's docs list adds SECURITY `:172`/`:269`, ARCHITECTURE `:460`, `domains/billing/README.md:102,323`
    (`@SkipThrottle`), PERFORMANCE `:525`, the `libs/redis/README.md:33` re-export row and the k6 script.
  - The C7 `rg` gate is split: a docs gate (all old names, including `SkipThrottle`) and a code gate (without
    `SkipThrottle`, which `rate-limit.decorator.ts`, the re-export and a C1 test legitimately keep). C4 now edits
    the `X-RateLimit-Reset` comment at `redis-throttler.storage.ts:22`, which its own `rg 'x-ratelimit'` gate would
    otherwise trip on.
  - The rename note no longer claims `SkipThrottle`/`Throttle` stop compiling: they compile and silently do nothing
    (Review Focus 1), so the note says to use `SkipRateLimit`/`RateLimit`.
  - Lockout wording states that the count is bounded by one `IDENTITY_LOCKOUT_MS` fixed window (Lua sets the hits
    TTL to `durationMs`): C2, `.env.example`, SECURITY.md.
  - Checked that `rate_limit_fail_open_total` reaches `/metrics`: `libs/observability` uses prom-client's default
    registry (no custom `registry`), which is where `makeCounterProvider` registers.
  - Review Focus 5 now matches the C7 Redis-down test (`/v1/auth/refresh`, not `/v1/users/me`).
- Cross-plan:
  - The shared-files table gains the following rows: the throttle namespace/spec (shared with ledger L-2a and E
    Task 7), `e2e-env.ts`, `integration.smoke.spec.ts` (shared with G Task 6), `all-exceptions.filter.spec.ts` (E
    Task 7), `graphql.module.ts`, the G `./api` entry points, k6 and the README test count.
  - C1 and C2 now work whether or not G Tasks 2/3 (`./api` entries, rewritten `*-api.module.ts` imports, gateway
    `@domain/x/api` imports) merged first.
  - Libs vocabulary (E Task 7): `identity.credentials` is gone from the libs spec and comments, and the C6 ws test
    pattern is `alerts.markRead`.
- Interfaces: the B2 contract is spelled out (`req.user.id`, credential handlers carry the policy and THROW on
  failure, guard order). The final `ThrottleConfig` shape, the config export placement and the removed names are in
  the contracts block. G-10 counts at the top of `recordDecision` and in `RateLimitCharger.charge`.

### Unresolved

- Not blocking:
  - The `RateLimit`/`RateLimit-Policy` field syntax (draft-ietf-httpapi-ratelimit-headers-11) was accepted by
    ruling and not re-verified against the draft text.
  - Wave 2 assumes `AuthUser.tenantId` and `signTestAccessToken({ tenantId })`. C8/C12 tell the implementer to
    revalidate the names when B2 merges.
  - C11 has no e2e for the socket caps (unit tests only); E-1's real Socket.IO spec can add one.
- Ordering: merge wave 1 (C1-C7) before B2-22 starts. This avoids conflicts in `app.module.ts`, identity's
  `auth.controller.ts`/`auth.resolver.ts` and the Api modules. It is not a hard dependency: B2 can rebase onto it.
