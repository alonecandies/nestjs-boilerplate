# Phase B4 implementation plan: tenant isolation outside Postgres, then the real-transport specs (E-1, E-2)

> Light plan (process rules of 2026-11-16): goals, files, interfaces, acceptance tests. Signatures and key formats
> are binding.

## Header

- **Goal.** Nothing outside Postgres can serve one tenant's data to another: the notifications inbox and recipients projection (Cassandra), cache keys (Redis), object keys (storage), Socket.IO rooms and GraphQL subscription triggers all carry the tenant, and an access token that was revoked or switched away from closes its live sockets on both WebSocket transports. Two real-connection suites (socket.io-client, graphql-ws) then prove the transports end to end.
- **Architecture.** Isolation is by key design; there is no RLS outside Postgres. Each store has one named key builder that takes `(tenantId, userId)`, and the tenant always comes from the principal or from a validated event envelope. Notifications learn the tenant from the Kafka envelope (B2-24) and the gRPC principal (B2-23); identity publishes membership events so the recipients projection follows memberships. One `RevocationSweeper` in `@platform/auth` serves Socket.IO and graphql-ws. Nothing in `libs/` names a domain.
- **Spec paths (binding).** `docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md` §7, §10, §13, §16 ("spec §n"). Contracts consumed: `2026-11-09-b2-core.md` I-1..I-5 and I-7..I-11; `2026-11-09-b2-edge.md` Task 3 (gRPC principal) and Task 4 (envelope `tenantId`/`actorId`) interfaces; `2026-11-16-b3-rls.md` `SystemContext.run(reason, fn)`; `2026-11-09-c-rate-limiting.md` lane table (C9-C11). Inventory: B4-1..B4-7, E-1, E-2.
- **Upstream state.** Written against `feat/domains-tenancy` after B2 core and B2 edge have merged. The branch is pre-B2 today, so files are named by path and symbol, never by line; where B2 renamed a symbol (`Permission.FilesManage` → `FilesPermission.Manage`), B2's contract name wins. Only Task 1 can start before B2. Next free CQL migration index: `003`.

### Global Constraints (one line each)

- Node: prefix `node`, `bun`, `npx` with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 24.4.0 >/dev/null;`.
- Search with `rg`, `fd`, `jaq`; `grep`, `find`, `jq` are blocked.
- One GPG-signed commit per task, commitlint-clean, no attribution lines; never push, never merge to `master`.
- Gates before each commit: `bun run check`, the task's specs and the unit projects of every package it touched; after a proto edit `bun run proto:gen` and `bun run proto:lint`; after an env change `node scripts/check-env-example.mjs`; after an event contract change `node scripts/docker/check-kafka-topics.mjs`.
- Every task leaves `bun run check` and the unit suites green on its own; no task relies on a later one to compile.
- **Tenant source.** A tenant id reaches a key only from `AuthUser.tenantId` / `requirePrincipal().tenantId` or from a validated envelope `tenantId`. A tenant in a request body, a gRPC field or an object key is only compared with the principal, never used as the source.
- **Fail closed.** A tenant-scoped event whose envelope has no `tenantId`, or `PLATFORM_TENANT_ID`, throws in the consumer (dead-letter queue): no write, no push, no mail. A principal without a tenant never reaches a key builder.
- **One builder per key format** (table below); no key of these stores is concatenated anywhere else.
- A key-format change ships with its migration story (section below) in the same task.
- Int specs need Docker and the sandbox off; the real-connection e2e specs bind `127.0.0.1` and need the sandbox off; no spec touches the developer's compose project.
- `libs/` names no domain, also in specs and fixtures (`scripts/libs-vocabulary.spec.ts`): use `orders`, `alerts`, `acme`.
- Controller only: `bun install` (Tasks 3 and 10), lane merges (`git merge --no-ff -S` after `git merge-tree`), the final review.

### Review Focus (one final review of the phase diff, `code-review high`; per-task reviews only where `review: yes`)

1. No path lets a client choose the tenant: every edge passes `user.tenantId`, every handler compares it with the principal, every consumer takes it from the envelope.
2. Cassandra: every statement binds both partition-key columns; no `ALLOW FILTERING`; a paging state from one tenant never yields another tenant's row; the user-keyed tables are gone.
3. Storage: the key is validated first, the tenant prefix is checked before ownership and before `files:manage`; a legacy `users/…` key is denied for everyone.
4. Rooms and triggers: a socket joins exactly one room, fixed at the handshake from its token; the trigger carries the tenant; the published object carries the tenant; the filter compares tenant and user.
5. The sweeper: same behaviour on both transports; a denylist error keeps sockets (the per-message guard stays closed); no overlapping sweep; timers unref'd and cleared on shutdown; closed sockets are untracked.
6. Cache: no tenant-scoped value under a key without the tenant; `user:<uid>` is never served to another tenant's caller without a live membership marker.
7. Idempotency keys that would merge two tenants' work for one user (the digest).

## Interfaces (B4 contract)

Consumed by C wave 2 (C11), E and G. Types not shown keep their current shape.

<!-- prettier-ignore -->
```ts
// ── @platform/config, auth namespace (Task 1) ──────────────────────────────────────────────────────────────────
// WS_REVOCATION_SWEEP_INTERVAL_MS → wsRevocationSweepIntervalMs   int 100..300000, default 30000; both transports

// ── @platform/auth root, libs/auth/src/ws/revocation-sweeper.ts (Task 1; used by Tasks 1 and 5) ────────────────
export interface RevocableSession { readonly jti: string; /** Tell the client why, then close. Must not throw. */ end(): void }
export class RevocationSweeper {
  constructor(denylist: Pick<AccessTokenDenylist, 'enabled' | 'isDenied'>, options: { name: string; intervalMs: number });
  /** Registers a live session. The returned function removes it (idempotent). */
  track(session: RevocableSession): () => void;
  /** One isDenied per distinct jti; ends and untracks the denied sessions; resolves how many ended. Never overlaps
   *  itself. A denylist error keeps every session, logs one warning and resolves 0; a disabled denylist resolves 0. */
  sweep(): Promise<number>;
  start(): void; // unref'd interval, idempotent
  stop(): void;  // clears the interval; tracked sessions stay open
  readonly size: number;
}
// ── @platform/graphql, libs/graphql/src/auth/subscription-auth.ts (Task 1) ─────────────────────────────────────
export const WS_CLOSE_TOKEN_REVOKED = 4401; // the code of WS_CLOSE_TOKEN_EXPIRED; reason 'Access token revoked'
export interface GraphqlWsAuthOptions { requireAuth?: boolean; sweeper?: RevocationSweeper } // C11 adds its option beside these

// ── @domain/identity-contracts (Task 2) ────────────────────────────────────────────────────────────────────────
// USER_REGISTERED_EVENT: payload unchanged, now { tenantScoped: true }; envelope tenantId = the personal workspace
export const membershipCreatedPayload = z.object({ userId: z.uuid(), email: z.email(), displayName: z.string(), createdAt: z.iso.datetime() });
export const MEMBERSHIP_CREATED_EVENT = defineEventContract('identity.membership-created.v1', membershipCreatedPayload, { tenantScoped: true });
export const membershipRemovedPayload = z.object({ userId: z.uuid(), removedAt: z.iso.datetime() });
export const MEMBERSHIP_REMOVED_EVENT = defineEventContract('identity.membership-removed.v1', membershipRemovedPayload, { tenantScoped: true });
// All three: envelope tenantId = the membership's tenant, passed as an explicit publish option (never the CLS
// default); Kafka key = userId (per-user order across created/removed); actorId = the acting user, or null.

// ── @domain/notifications-contracts (Task 4) ───────────────────────────────────────────────────────────────────
// NOTIFICATION_CREATED_EVENT: payload unchanged, now { tenantScoped: true }; envelope tenantId = the inbox tenant
// notifications.v1: Notification.tenant_id = 9; ListNotificationsRequest.tenant_id = 4;
//   MarkNotificationReadRequest.tenant_id = 3 (`optional string` on the wire; both request schemas require a UUID)

// ── @domain/notifications root (Tasks 3, 4) ────────────────────────────────────────────────────────────────────
interface NotificationProps { /* … */ tenantId: string } // CreateNotificationInput, WelcomeUserInput, receipt input: + tenantId
abstract class NotificationsRepository {
  abstract insert(notification: Readonly<NotificationProps>): Promise<void>;
  abstract listByUser(tenantId: string, userId: string, limit: number, pageState?: string): Promise<NotificationsSlice>;
  abstract findRecentByUser(tenantId: string, userId: string, limit: number): Promise<NotificationProps[]>;
  abstract markRead(tenantId: string, userId: string, notificationId: string): Promise<boolean>;
}
interface NotificationRecipient { tenantId: string; userId: string; email: string; displayName: string; updatedAt: Date }
abstract class NotificationRecipientsRepository {
  abstract upsert(recipient: NotificationRecipient): Promise<void>;
  abstract find(tenantId: string, userId: string): Promise<NotificationRecipient | null>; // replaces findById
  abstract remove(tenantId: string, userId: string): Promise<void>;                        // idempotent
  abstract scan(limit: number, pageState?: string): Promise<NotificationRecipientsSlice>;  // one item per (tenant, user)
}
/** The principal must be exactly this tenant and this user. @throws PermissionDeniedException code TENANT_MISMATCH (403) */
export function requireInboxActor(tenantId: string, userId: string): Principal; // application/inbox-actor.ts
/** The envelope's tenant. @throws DomainValidationException when absent or PLATFORM_TENANT_ID (the consumer dead-letters) */
export function requireEventTenant(event: { tenantId?: string | undefined }): string; // presentation/messaging/event-tenant.ts
// @domain/notifications/testing: InMemoryNotificationRecipientsRepository (Task 3), InMemoryNotificationsRepository
//   (Task 4); FakeNotificationsPort keys its inbox by (tenantId, userId) and add() requires tenantId (Task 4)

// ── @domain/notifications/api (Tasks 5, 6) ─────────────────────────────────────────────────────────────────────
export const tenantUserRoom = (tenantId: string, userId: string): string => `t:${tenantId}:u:${userId}`; // replaces userRoom
class NotificationsGateway { pushToUser(tenantId: string, userId: string, notification: NotificationResponse): void }
export const notificationCreatedTrigger = (tenantId: string, userId: string): string => `notificationCreated:${tenantId}:${userId}`;
export type NotificationCreatedPush = NotificationCreatedPayload & { tenantId: string }; // what the push consumer publishes
export function isOwnNotification(payload: NotificationCreatedPush, _variables: unknown, context: GqlContext): boolean;
// removed from ./api: userRoom, WS_REVOCATION_SWEEP_INTERVAL_MS (API_VALUES in src/api/api-surface.spec.ts follows)

// ── @platform/redis root, libs/redis/src/cache/tenant-cache-key.ts (Task 7) ────────────────────────────────────
/** `<scope>:<tenantId>:<part>…`; AppCacheService adds `${REDIS_KEY_PREFIX}:cache:`. scope /^[a-z][a-z0-9-]*$/; tenantId
 *  a UUID (lower-cased), never PLATFORM_TENANT_ID; at least one part, none empty or containing ':'. @throws TypeError */
export function tenantCacheKey(scope: string, tenantId: string, ...parts: readonly RedisKeyPart[]): string;
// ── @domain/identity (Task 7) ──────────────────────────────────────────────────────────────────────────────────
export const tenantMemberCacheKey = (tenantId: string, userId: string): string => tenantCacheKey('identity', tenantId, 'member', userId);
class UserReadCache {
  getUser(id: string): Promise<User>;                         // the caller's own profile; key user:<id>, unchanged
  getScopedUser(id: string, tenantId: string): Promise<User>; // B2 Task 12's uncached read becomes marker + user:<id>
  invalidate(id: string): Promise<void>;
  invalidateMembership(tenantId: string, userId: string): Promise<void>; // best effort, like invalidate
}

// ── @domain/files (Task 8) ─────────────────────────────────────────────────────────────────────────────────────
export type FileActor = Pick<AuthUser, 'id' | 'tenantId' | 'permissions'>;
export const TENANT_FILES_ROOT = 'tenants';                                        // USER_FILES_ROOT stays 'users'
export function tenantFilesPrefix(tenantId: string): string;                       // tenants/<tid>
export function userFilesPrefix(tenantId: string, userId: string): string;         // tenants/<tid>/users/<uid>
export function buildUserFileKey(tenantId: string, userId: string, filename: string, id?: string): string;
export function resolveFileAccess(actor: FileActor, key: string): FileAccess;      // decision order in Task 8

// ── @platform/testing (Tasks 3, 10) ────────────────────────────────────────────────────────────────────────────
// ./cassandra
export const TEST_CASSANDRA_IMAGE = 'cassandra:5.0.9'; // the compose tag; a spec pins the two equal
export interface TestCassandra { readonly contactPoints: string[]; readonly localDataCenter: string; readonly keyspace: string; stop(): Promise<void> }
export function startTestCassandra(options?: { keyspace?: string }): Promise<TestCassandra>; // creates the keyspace, RF 1
// ./realtime
export function listenOnLoopback(app: NestFastifyApplication): Promise<{ httpUrl: string; wsUrl: string }>; // 127.0.0.1, port 0
```

**Key formats (binding; one builder each).**

| Store                     | Key                                                                                                                                                     | Builder                                | Task |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---- |
| Cassandra inbox           | table `notifications_by_tenant_user`, `PRIMARY KEY ((tenant_id, user_id), notification_id)`, clustering `notification_id DESC`, default TTL 7776000 s   | `004_…cql`, `NOTIFICATIONS_CQL`        | 4    |
| Cassandra recipients      | table `notification_recipients_by_tenant`, `PRIMARY KEY ((tenant_id, user_id))`                                                                         | `003_…cql`, `RECIPIENTS_CQL`           | 3    |
| Socket.IO room            | `t:<tid>:u:<uid>`                                                                                                                                       | `tenantUserRoom`                       | 5    |
| GraphQL trigger (Redis)   | `notificationCreated:<tid>:<uid>`                                                                                                                       | `notificationCreatedTrigger`           | 6    |
| Redis cache, tenant data  | `<prefix>:cache:<scope>:<tid>:…`                                                                                                                        | `tenantCacheKey`                       | 7    |
| Redis cache, user profile | `<prefix>:cache:user:<uid>` (unchanged) plus the marker `<prefix>:cache:identity:<tid>:member:<uid>`                                                    | `userCacheKey`, `tenantMemberCacheKey` | 7    |
| Storage object            | `tenants/<tid>/users/<uid>/<uuidv7>/<safeFilename>`                                                                                                     | `buildUserFileKey`                     | 8    |
| Mail idempotency          | digest `digest-<tid>-<uid>-<day>`; `welcome-<uid>` and `receipt-<paymentId>` unchanged (one tenant each by construction)                                | the handlers                           | 3    |
| Unchanged (spec §10)      | `auth:denylist:<jti>`, `lock:*`, `throttle:*` (C8 owns the tenant bucket), `notifications:push:dedupe:<envelope id>`, BullMQ and Socket.IO adapter keys | —                                      | —    |

**What a tenant switch guarantees.** B2 Task 14 denylists the access token presented to `switch-tenant`. Every socket
authenticated with that token, on either transport and on every replica, is closed by its replica's sweep within
`WS_REVOCATION_SWEEP_INTERVAL_MS` (Socket.IO: `exception` `TOKEN_REVOKED`, then disconnect; graphql-ws: close 4401
`Access token revoked`), and Socket.IO messages on it are refused at once by `WsSessionGuard`. A socket never
changes room or trigger: the new tenant needs a new connection with the new token. There is no room-wide close:
access tokens carry no session id (I-3), so the user's other sessions in the old tenant stay connected (spec delta 1).

## Lanes and merge order

| Lane | Branch             | Tasks         | Owns exclusively                                                                                                                                                                                                                                                                                |
| ---- | ------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G    | `b4/ws-revocation` | 1             | `libs/auth/src/ws/revocation-sweeper.{ts,spec.ts}`, `libs/config/src/namespaces/auth.config.ts`, `libs/graphql/src/auth/**`, `libs/graphql/src/graphql.module.ts`                                                                                                                               |
| I    | `b4/identity`      | 2, then 7     | `domains/identity/contracts/src/events/**`, `domains/identity/src/domain/events/**`, `domains/identity/src/application/event-handlers/**`, `domains/identity/src/presentation/shared/**`, `libs/redis/src/cache/**`, `docker/kafka/topics.txt`, `apps/monolith/test/tenancy-events.e2e-spec.ts` |
| N    | `b4/notifications` | 3 → 4 → 5 → 6 | `domains/notifications/**`, `apps/notifications-service/**`, `libs/testing/src/cassandra/**`                                                                                                                                                                                                    |
| F    | `b4/files`         | 8             | `domains/files/**`                                                                                                                                                                                                                                                                              |
| Q    | `b4/quality`       | 9 → 10 → 11   | `apps/{monolith,gateway}/test/{tenant-isolation,realtime-socket,realtime-graphql}.e2e-spec.ts`, `apps/{monolith,gateway}/test/support/**`, `libs/testing/src/realtime/**`, `docs/**`, `README.md`                                                                                               |

Edits outside a lane's own files, each a line or two: Task 1 in root and app `.env.example` and
`docs/{CONFIGURATION,SECURITY}.md`; Task 2 in the identity command handlers that write memberships (B2 files, merged
by then); Task 7 in the B2 edge member presentation (remove, leave); Tasks 3 and 10 in `libs/testing/package.json`
and the root `package.json` catalog; Tasks 3-8 in `docs/API.md` (different sections). Shared, both sides kept:
`libs/{auth,redis,testing}/src/index.ts`, `domains/identity/src/api/index.ts`, the package READMEs, and the
`.env.example` files (B3's lane I owns `apps/*/.env.example`; Task 1 adds one line to each).

**Order against C wave 2 (lane `c-tenant`: C8 → C9 → C10 → C11 → C12).** B4 goes first on every shared file:

| File                                                                           | B4          | C            | Order                                                                               |
| ------------------------------------------------------------------------------ | ----------- | ------------ | ----------------------------------------------------------------------------------- |
| `libs/graphql/src/auth/subscription-auth.{ts,spec.ts}`                         | Task 1      | C11          | Task 1 merges first; C11 adds its `onConnect`/`onClose` calls beside the sweeper    |
| `libs/graphql/src/graphql.module.ts`                                           | Task 1      | C9, C10, C11 | Task 1 merges before C9 starts (it needs no B2, so it can merge at once)            |
| `domains/notifications/src/presentation/ws/notifications.gateway.{ts,spec.ts}` | Tasks 4, 5  | C11          | Task 5 merges first; C11 edits the handshake and close callbacks afterwards         |
| `libs/config/src/namespaces/namespaces.spec.ts`, root `.env.example`           | Task 1      | C8, C9, C11  | different tests and sections; keep both sides                                       |
| `libs/redis/src/index.ts`                                                      | Task 7      | C8-C11       | export lines; keep both sides                                                       |
| `libs/graphql/src/apollo-config.factory.ts`                                    | not touched | C10          | B4 needs no change there: `onConnect`/`onClose` already delegate to the auth module |

**Order against B2 and B3.** Tasks 2-8 need B2 only (core and edge merged), so B4 can run alongside B3. Task 9
needs B3 merged: `SystemContext` (B3 Task 7) for the digest cron, B3's harness edits, and the payments proof of B3
Task 19. Tasks 10 and 11 come after Task 9; Task 11 also needs C10 for its complexity case.

1. **Wave 0 (any time).** G: Task 1. Merge it before C9 starts.
2. **Wave 1 (after B2; at most three agents).** I: Task 2, then Task 7. F: Task 8. N: Task 3, started from the
   commit that has Task 2 merged (it imports Task 2's contracts). Merge order: Task 2 first (producers set the
   tenant before consumers require it), then F, then Task 7.
3. **Wave 2 (N serial).** Task 4, Task 5 (needs Task 1 merged), Task 6. Merge `b4/notifications` as a whole; tell
   the C lane that C11 may start.
4. **Wave 3 (Q serial, after B3).** Task 9, then 10, then 11. Full gate: `bun run check`, `bun run test`, the `:int`
   projects, both topology builds.
5. One final review of the phase diff (`code-review high`), one fix round, one scoped re-review.

## Migration story for existing dev data (per store)

| Store     | What changes                                                         | Existing data                                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cassandra | two new tables (`003`, `004`); `005` drops the two user-keyed tables | No backfill: a user-keyed row has no tenant, and Cassandra cannot derive one. Old inbox rows (90-day TTL, best effort) and old recipients are dropped. Recipients come back only from new membership events, so dev resets its data (`docker compose down -v`, already required after B3). |
| Redis     | new cache marker keys, new trigger names; `user:<uid>` unchanged     | Nothing to migrate: cache entries live at most `CACHE_TTL_MS`, triggers and rooms are not stored. Denylist, lock and throttle keys keep their format.                                                                                                                                      |
| Storage   | new keys under `tenants/<tid>/users/<uid>/`                          | No copy. Objects under `users/…` stay in the bucket and are unreachable through the API (every caller gets 403). Dev empties the bucket with the same reset. `domains/files/README.md` gives the one-line provider CLI move for an adopter who keeps objects.                              |
| Kafka     | two new topics (+ `.dlq`); three contracts become tenant-scoped      | Events published before B2-24 have no envelope `tenantId`; a replay dead-letters them (fail closed). Dev resets the broker volume with the same command.                                                                                                                                   |
| Tokens    | none (B2 did)                                                        | Live sockets opened before the deploy hold pre-B4 rooms and triggers in memory only; a restart drops them.                                                                                                                                                                                 |

## Tasks

### Task 1: graphql-ws revocation sweep and the shared sweeper (B4-6, AUDIT-F18, FU-8)

- **Goal.** graphql-ws sockets are tracked by `jti` and swept against the denylist exactly as Socket.IO sockets
  are; today the denylist is read only at `connection_init`. The sweep logic becomes one `RevocationSweeper` in
  `@platform/auth` that both transports use (the Socket.IO gateway adopts it in Task 5), and the interval becomes
  configuration, so the real-connection specs can run a sweep in milliseconds. Needs nothing from B2.
- **Files.** Create `libs/auth/src/ws/revocation-sweeper.{ts,spec.ts}`. Modify `libs/auth/src/index.ts`,
  `libs/auth/README.md`, `libs/config/src/namespaces/{auth.config.ts,namespaces.spec.ts}`,
  `libs/graphql/src/auth/subscription-auth.{ts,spec.ts}`, `libs/graphql/src/graphql.module.ts` (one sweeper named
  `graphql-ws`, built from `AccessTokenDenylist` and `authConfig`, passed to `createGraphqlWsAuthHandlers`, started
  on application bootstrap and stopped on shutdown), `libs/graphql/README.md`, root `.env.example` and every
  `apps/*/.env.example` that lists `AUTH_DENYLIST_ENABLED`, `docs/CONFIGURATION.md`, `docs/SECURITY.md` (the WebSocket paragraph says
  graphql-ws is swept too and names the 4401 `Access token revoked` close; the "Known gaps" bullet says revocation
  takes up to the configured interval on both transports).
- **Interfaces.** Contract: the config key, `RevocationSweeper`, `WS_CLOSE_TOKEN_REVOKED`,
  `GraphqlWsAuthOptions.sweeper`. `onConnect` with a valid token tracks `{ jti: user.jti, end: () =>
socket.close(WS_CLOSE_TOKEN_REVOKED, 'Access token revoked') }`; `onClose` untracks and clears the expiry timer.
  Without the option, behaviour is today's.
- **Acceptance tests.**
  - `revocation-sweeper.spec.ts` (fake timers, a fake denylist): denied sessions are ended once and untracked,
    the others untouched; two sessions sharing a jti cost one `isDenied` and both end; `isDenied` rejecting ends
    nobody, logs one warning, resolves 0, and the next sweep works; a second `sweep()` while one is in flight
    resolves 0 without calling `isDenied`; `enabled: false` makes no call; an `end()` that throws does not stop the
    other sessions; the untrack function is idempotent; `start()` twice creates one timer; `stop()` ends sweeping;
    `size` follows track, untrack and sweep.
  - `subscription-auth.spec.ts`: an accepted connection is tracked and untracked on close; after its jti is denied,
    one sweep closes that socket with 4401 `Access token revoked` and leaves a connection with another jti open; a
    refused connection and an anonymous one (`requireAuth: false`) are never tracked; expiry still closes with 4401
    `Access token expired`; with no sweeper nothing is tracked and nothing throws.
  - `namespaces.spec.ts`: default 30000; 99, 300001 and a non-integer are rejected; 100 is accepted.
  - The module spec that boots `AppGraphqlModule`: after `app.close()` no sweeper timer is left.
- **Dependencies.** None. **Lane.** G (wave 0; merge before C9). **Review:** yes.

### Task 2: Identity events carry the tenant; membership events (B4-1, producer side)

- **Goal.** Notifications can key by `(tenant, user)` only if every identity event says which tenant it is about.
  `identity.user-registered.v1` becomes tenant-scoped (the personal workspace), and two new events report every
  membership that is created or removed, so the recipients projection (Task 3) follows memberships, not only
  registrations. Publishing uses the existing publish-after-commit relay pattern (`UserRegisteredRelay`); G-1's
  outbox replaces relays later.
- **Files.** Modify `domains/identity/contracts/src/events/identity.events.{ts,spec.ts}`,
  `domains/identity/contracts/{src/index.ts,README.md}`. Create
  `domains/identity/src/domain/events/{membership-created,membership-removed}.event.ts`,
  `domains/identity/src/application/event-handlers/membership-events.relay.{ts,spec.ts}`,
  `apps/monolith/test/tenancy-events.e2e-spec.ts`. Modify
  `domains/identity/src/application/event-handlers/user-registered.relay.{ts,spec.ts}` and whatever hands the
  relay the workspace id (the domain event or the register handler), `domains/identity/src/identity-core.module.ts`,
  `domains/identity/src/index.ts`, every production caller of `MembershipsRepository.insert` and `.delete` (find
  them with `rg 'memberships\.(insert|delete)\(' domains/identity/src -g '!*.spec.ts'`; expected: `PersonalWorkspaces`
  for register and for a login without a membership, tenant creation, invitation acceptance, member removal,
  leave), `docker/kafka/topics.txt` (four lines, same partitions and retention as `identity.user-registered.v1`
  and its `.dlq`), `docs/API.md` (Kafka section), and every spec that builds a `USER_REGISTERED_EVENT` envelope
  (`rg 'USER_REGISTERED_EVENT' -g '*spec.ts' domains apps`; the notifications consumer specs and
  `apps/{monolith,notifications-service}/test/app.e2e-spec.ts` among them): each fixture gains a `tenantId`. The
  gate for this task includes the `notifications`, `notifications-service:e2e` and `monolith:e2e` projects.
- **Interfaces.** Contract: the three identity events. A domain event is published only after its unit of work
  committed; a relay failure is logged and never thrown, as today.
- **Acceptance tests.**
  - `identity.events.spec.ts`: the three contracts have `tenantScoped === true`; `createEventEnvelope` without a
    `tenantId` throws for each; the payload schemas reject a non-UUID `userId` and a malformed email.
  - Both relay specs: the publish options carry `tenantId` = the event's tenant, `key` = the user id and `eventId`
    = the domain event id; an active CLS principal of another tenant does not change the envelope tenant; a
    producer error is logged and swallowed.
  - `tenancy-events.e2e-spec.ts` (monolith harness, `FakeKafkaProducer`): register publishes exactly one
    `user-registered` and one `membership-created`, both with the `tenantId` of the register response; creating a
    second tenant publishes one `membership-created` for it; invite then accept publishes one for (the inviter's
    tenant, the invitee) with the invitee's email; removing that member publishes one `membership-removed`; leave
    publishes one; the login of a seeded user without a membership publishes one `membership-created` for the new
    workspace; a rejected command (accepting the same invitation twice) publishes nothing.
  - `node scripts/docker/check-kafka-topics.mjs` exits 0.
- **Dependencies.** B2 core Tasks 7, 8; B2 edge Tasks 4, 7-9. **Lane.** I (wave 1; merges first). **Review:** no.

### Task 3: Recipients projection keyed by `(tenant_id, user_id)`, fed by membership events (B4-1)

- **Goal.** The recipients projection holds one row per `(tenant, user)`, written by `membership-created` and
  removed by `membership-removed`, so mail follows memberships and stops when one ends. The receipt looks its
  recipient up in the payment's tenant, and the digest walks `(tenant, user)` pairs with one idempotency key per
  pair. The task also ships the Cassandra test container. The inbox stays user-keyed until Task 4; the lane merges
  as a whole.
- **Files.** Create in `domains/notifications/src`:
  `infrastructure/persistence/migrations/003_create_notification_recipients_by_tenant.cql`,
  `application/commands/{upsert-recipient,remove-recipient}/**`,
  `presentation/messaging/event-tenant.{ts,spec.ts}`, `testing/in-memory-notification-recipients.repository.ts`;
  `domains/notifications/test/recipients.int-spec.ts`;
  `libs/testing/src/cassandra/{index.ts,start-test-cassandra.ts,start-test-cassandra.int-spec.ts}`. Modify
  `libs/testing/{package.json,README.md}` (`exports` gains `./cassandra`; `dependencies` gains
  `"testcontainers": "catalog:"`; controller `bun install`); in `domains/notifications/src`:
  `application/ports/notification-recipients.repository.ts`,
  `infrastructure/persistence/cassandra-notification-recipients.repository.{ts,spec.ts}`,
  `infrastructure/persistence/notifications-cassandra.migrations.spec.ts`,
  `application/commands/{welcome-user,send-payment-receipt,send-daily-digest}/**`,
  `presentation/messaging/{identity-events,billing-events}.consumer.ts` and their spec,
  `notifications-core.module.ts`, `testing/index.ts`, `README.md`;
  `apps/notifications-service/test/app.e2e-spec.ts`, `apps/notifications-service/.env.example` (the
  consumer-group comment), `docs/API.md` (Kafka consumers).
- **Interfaces.** Contract: `NotificationRecipient`, `NotificationRecipientsRepository`, `requireEventTenant`, the
  digest key, `@platform/testing/cassandra`. Rules:
  - `membership-created` upserts `(requireEventTenant(event), payload.userId)`; `membership-removed` removes it.
    Both statements run `USING TIMESTAMP` = the event's time in microseconds (`createdAt`, `removedAt`), so replays
    and reordered deliveries converge and a replayed `created` cannot resurrect a removed member.
  - The welcome stops writing recipients (its mail uses the event's own email). The receipt command takes the
    tenant from `requireEventTenant(event)` and calls `recipients.find(tenantId, userId)`.
  - No recipient row for the pair: the inbox entry is still created, the mail is skipped with one warning (today's
    behaviour). There is no lookup in another tenant.
  - The digest sends one mail per scanned pair, keyed `digest-<tid>-<uid>-<day>`.
- **Acceptance tests.**
  - `cassandra-notification-recipients.repository.spec.ts`: exact text and parameter order; upsert, find and
    remove bind `tenant_id` then `user_id`; upsert and remove carry `USING TIMESTAMP`; every statement names
    `notification_recipients_by_tenant`.
  - `notifications-cassandra.migrations.spec.ts`: `003` declares `PRIMARY KEY ((tenant_id, user_id))`.
  - `recipients.int-spec.ts` (`startTestCassandra()`, the real migrations and repository): U is a recipient in A
    and in B with different addresses, and `find` returns each pair's own row; `remove(A, U)` leaves (B,U); an
    upsert stamped earlier than a later-stamped remove does not bring the row back, one stamped later does; `scan`
    returns every pair once, with its tenant.
  - Handler specs: a receipt for (B,U) with a recipient only in A creates the inbox entry, sends no mail and warns
    once; with a recipient in B it mails that address; the digest over recipients (A,U) and (B,U) enqueues two
    mails with the keys `digest-<A>-<U>-<day>` and `digest-<B>-<U>-<day>`.
  - Consumer spec: `membership-created`, `membership-removed` and `payment-succeeded` envelopes without `tenantId`
    reject and execute no command; with one, the command input carries the envelope's tenant.
  - `event-tenant.spec.ts`: a UUID is returned; undefined, a malformed value and the nil UUID throw.
  - `apps/notifications-service/test/app.e2e-spec.ts`: a delivered `membership-created` executes an INSERT into
    `notification_recipients_by_tenant` bound to the envelope's tenant; `membership-removed` a DELETE; an envelope
    without `tenantId` lands on the `.dlq` topic and executes neither.
  - `start-test-cassandra.int-spec.ts`: the keyspace exists; `stop()` twice is safe; `TEST_CASSANDRA_IMAGE` equals
    the Cassandra image tag in `docker-compose.yml`.
- **Dependencies.** Task 2 merged; B2 edge Task 4. **Lane.** N (first). **Review:** yes.

### Task 4: The inbox is keyed by `(tenant_id, user_id)`; drop the user-keyed tables (B4-1)

- **Goal.** Every inbox row lives in the partition `(tenant_id, user_id)`, and every path to it names both: the
  Cassandra table and repository, the commands and queries, the gRPC contract, the three edges and the fakes. A
  user who belongs to two tenants has two inboxes, and the digest reads each pair's own inbox. The last migration
  drops the two user-keyed tables.
- **Files.** Create in `domains/notifications/src`:
  `infrastructure/persistence/migrations/{004_create_notifications_by_tenant_user,005_drop_user_keyed_tables}.cql`,
  `application/inbox-actor.{ts,spec.ts}`, `testing/in-memory-notifications.repository.ts`; and
  `domains/notifications/test/inbox-isolation.int-spec.ts`. Modify `domains/notifications/contracts`: the proto
  and its generated code, `src/events/notifications.events.{ts,spec.ts}`; in `domains/notifications/src`:
  `domain/{notification.types,notification.entity,notification.errors}.ts`,
  `domain/events/notification-created.event.ts`, `application/ports/notifications.repository.ts`,
  `application/commands/{create-notification,mark-notification-read,publish-notification-created,welcome-user,send-payment-receipt,send-daily-digest}/**`,
  `application/queries/list-notifications/**`, `application/mappers/**`,
  `infrastructure/persistence/{cassandra-notifications.repository,notifications-cassandra.migrations}.{ts,spec.ts}`,
  `infrastructure/adapters/{local,grpc}/**`, `presentation/grpc/**`, the port calls in
  `presentation/http/notifications.controller.ts`, `presentation/graphql/notifications.resolver.ts` and
  `presentation/ws/notifications.gateway.ts` (`tenantId: user.tenantId`),
  `presentation/messaging/identity-events.consumer.ts`, `testing/{fake-notifications-port,index}.ts`, the specs
  beside them, `README.md`; `apps/notifications-service/test/{app.e2e-spec.ts,support/**}`; the
  `FakeNotificationsPort.add` call sites in `apps/gateway/test/*.e2e-spec.ts` (they now pass `tenantId`); every
  spec that builds a `NOTIFICATION_CREATED_EVENT` envelope (`rg 'NOTIFICATION_CREATED_EVENT' -g '*spec.ts'`) gives
  it a `tenantId`.
- **Interfaces.** Contract: the proto fields, the tenant-scoped event, `NotificationProps.tenantId`,
  `NotificationsRepository`, `requireInboxActor`, the testing fakes. Rules:
  - `ListNotificationsHandler` and `MarkNotificationReadHandler` call `requireInboxActor(tenantId, userId)` before
    the repository; this is the one enforcement point for both topologies.
  - `CreateNotificationCommand` takes the tenant from its input; the `user-registered` consumer passes
    `requireEventTenant(event)` to the welcome, the receipt passes the tenant it already has;
    `PublishNotificationCreatedHandler` publishes with the explicit option `tenantId: notification.tenantId`.
  - All four CQL statements address `notifications_by_tenant_user` and bind `tenant_id` then `user_id`. The digest
    calls `findRecentByUser(recipient.tenantId, recipient.userId, …)`.
  - Derived-id keys stay `welcome:<userId>` and `receipt:<paymentId>` (each exists in one tenant only).
- **Acceptance tests.**
  - `cassandra-notifications.repository.spec.ts`: exact statement text and parameter order for the four
    statements; none contains `ALLOW FILTERING` or `notifications_by_user`.
  - `notifications-cassandra.migrations.spec.ts`: `NOTIFICATIONS_TTL_SEC` equals the `default_time_to_live` of
    `004`; `004` declares `PRIMARY KEY ((tenant_id, user_id), notification_id)`; `005` holds exactly two
    statements, `DROP TABLE IF EXISTS` for `notifications_by_user` and for `notification_recipients`.
  - `inbox-isolation.int-spec.ts` (`startTestCassandra()`, all five migrations, the real repositories): the two
    old tables are absent from `system_schema.tables`; U has n1 in tenant A and n2 in B, V has n3 in A;
    `listByUser` returns exactly `[n1]`, `[n2]`, `[n3]` for (A,U), (B,U), (A,V); `markRead(B, U, n1)` is false and
    n1 stays unread; `markRead(A, U, n1)` is true and n2 is unaffected; with three rows each in (A,U) and (B,U),
    the paging state of a two-row page of (A,U) replayed on (B,U) returns only (B,U) rows or rejects, never an
    (A,U) row; re-inserting a read notification keeps it read; digest with a recording mail service: U has unread
    n1 in A and n2 in B, V has unread n3 in A, W is a recipient in A with nothing unread → exactly three mails,
    (A,U) lists only n1, (B,U) only n2, (A,V) only n3; after `recipients.remove(A, U)` the next day's run sends
    none for (A,U).
  - `inbox-actor.spec.ts`: the matching principal is returned; another tenant, another user and a tenant-less
    principal get 403 `TENANT_MISMATCH`; no principal gets `PRINCIPAL_MISSING`; a staff switch-in principal passes
    only for its own pair.
  - Handler specs: list and markRead reject a mismatch before any repository call; create stores the input tenant
    and raises the event with it; the publish handler's options carry `tenantId`.
  - Consumer spec: a `user-registered` envelope without `tenantId` rejects and executes no command; with one, the
    welcome's notification is created in the envelope's tenant.
  - gRPC specs: both request schemas reject a missing or malformed `tenant_id`; over the in-memory gRPC server, a
    principal (A,U) asking for (B,U) or (A,V) gets `PERMISSION_DENIED` `TENANT_MISMATCH`; every returned item has
    `tenant_id`.
  - `apps/notifications-service/test/app.e2e-spec.ts`: with metadata for (A,U), list binds (A,U) in the executed
    CQL; the same metadata with body tenant B is `PERMISSION_DENIED` and executes no CQL; no principal metadata is
    `UNAUTHENTICATED`; a delivered `user-registered` envelope without `tenantId` lands on the `.dlq` topic and no
    INSERT ran.
- **Dependencies.** Task 3; B2 edge Tasks 3, 4. **Lane.** N. **Review:** yes.

### Task 5: Socket.IO tenant rooms; a switched-away token closes its sockets (B4-4)

- **Goal.** A socket joins exactly one room, `t:<tid>:u:<uid>`, from the token it authenticated with, and pushes
  address `(tenant, user)`, so a user connected in tenant A never receives tenant B's notifications, their own
  included. The gateway's sweep moves onto the shared `RevocationSweeper` with the configured interval. Because a
  tenant switch denylists the old access token, that sweep is what closes the old tenant's sockets.
- **Files.** Modify `domains/notifications/src/notifications.constants.ts` (`tenantUserRoom`; delete `userRoom`),
  `domains/notifications/src/presentation/ws/notifications.gateway.{ts,spec.ts}` (delete the exported constant
  `WS_REVOCATION_SWEEP_INTERVAL_MS` and the private sweep loop; inject `authConfig`),
  `domains/notifications/src/presentation/messaging/notification-push.consumer.{ts,spec.ts}`,
  `domains/notifications/src/api/{index.ts,api-surface.spec.ts}`, `domains/notifications/README.md`,
  `docs/API.md` (WebSocket section).
- **Interfaces.** Contract: `tenantUserRoom`, `pushToUser(tenantId, userId, …)`. Behaviour:
  - `handleConnection` joins `tenantUserRoom(user.tenantId, user.id)` and nothing else, and tracks
    `{ jti, end }` in the sweeper (`end` sends `exception` `TOKEN_REVOKED`, then disconnects); `handleDisconnect`
    untracks. No message handler joins or leaves a room.
  - `afterInit` starts the sweeper (`name: 'socket.io'`, `intervalMs: wsRevocationSweepIntervalMs`);
    `onModuleDestroy` stops it. `disconnectRevokedSockets()` stays public and delegates to `sweeper.sweep()`.
  - `NotificationPushConsumer` takes the tenant from `requireEventTenant(event)` before the dedupe claim.
- **Acceptance tests.**
  - `notifications.gateway.spec.ts`: a socket of (A,U) calls `join` once, with exactly `t:A:u:U`;
    `pushToUser(A, U, n)` emits to `t:A:u:U` only, so U's socket authenticated for B and V's socket in A receive
    nothing; tenant switch: U holds s1 (jti1, tenant A) and s2 (jti2, tenant A), after `deny(jti1)` one sweep
    sends `exception` `TOKEN_REVOKED` to s1 and disconnects it while s2 stays, and a socket connecting with the
    token for B joins `t:B:u:U` only; with the interval configured to 200 the sweep runs at 200 ms (fake timers)
    and stops after module destroy; a denylist error during a sweep disconnects nobody; the handshake and expiry
    tests still pass with tenant-carrying users.
  - `notification-push.consumer.spec.ts`: an envelope for tenant A pushes to (A, `payload.userId`); an envelope
    without `tenantId` rejects before the dedupe claim and pushes nothing; a redelivery pushes nothing.
  - `api-surface.spec.ts`: `API_VALUES` has `tenantUserRoom` and lacks `userRoom` and
    `WS_REVOCATION_SWEEP_INTERVAL_MS`.
- **Dependencies.** Tasks 1, 4. **Lane.** N. Merges before C11 starts. **Review:** yes.

### Task 6: Subscription triggers and filters on tenant and user (B4-5)

- **Goal.** The `notificationCreated` subscription listens on a trigger that names tenant and user, and its filter
  re-checks both against the connection's user, so a payload published on a wrong trigger still reaches nobody
  else. The published object carries the tenant, because the filter sees that object and not the Kafka envelope.
- **Files.** Modify `domains/notifications/src/notifications.constants.ts`,
  `domains/notifications/src/presentation/graphql/notifications.resolver.{ts,spec.ts}`,
  `domains/notifications/src/presentation/messaging/notification-push.consumer.{ts,spec.ts}`,
  `domains/notifications/src/api/index.ts`, `domains/notifications/README.md`, `docs/API.md` (subscriptions).
- **Interfaces.** Contract: `notificationCreatedTrigger`, `NotificationCreatedPush`, `isOwnNotification`. The
  resolver subscribes to `notificationCreatedTrigger(user.tenantId, user.id)`, both from `@CurrentUser()`; the
  consumer publishes `{ ...payload, tenantId }` on `notificationCreatedTrigger(tenantId, payload.userId)`;
  `resolve` maps to the unchanged GraphQL model (no `tenantId` field in the schema).
- **Acceptance tests.**
  - `notifications.resolver.spec.ts`: `isOwnNotification` is true only when tenant and user both match; false for
    the same user in another tenant, another user in the same tenant, a payload without `tenantId` and a context
    without a user; the subscription asks the pubsub for exactly `notificationCreated:<A>:<U>`; with an in-process
    `PubSub`, a publish for (A,U) reaches the (A,U) iterator and neither the (B,U) nor the (A,V) iterator; a
    payload for (B,U) published on the (A,U) trigger is filtered out.
  - `notification-push.consumer.spec.ts`: the published trigger and object are exactly as above.
- **Dependencies.** Task 5 (same files). **Lane.** N (last). **Review:** yes.

### Task 7: Tenant-scoped cache keys and the user cache re-check (B4-2)

- **Goal.** Tenant-scoped cache entries get one builder that puts the tenant in the key. The user cache stays
  keyed by user, and serves another user's profile only to a caller whose active tenant that user belongs to. B2
  Task 12 made such reads bypass the cache; this task caches them again behind a per-tenant membership marker.
- **Files.** Create `libs/redis/src/cache/tenant-cache-key.{ts,spec.ts}`. Modify `libs/redis/src/index.ts`,
  `libs/redis/README.md`, `domains/identity/src/identity.constants.ts`,
  `domains/identity/src/presentation/shared/user-read.cache.ts` and its spec (create it if absent), the member
  removal and leave edges of B2 edge Task 8 (REST controller and GraphQL resolver: call `invalidateMembership`
  after a successful remove or leave) and their specs, `domains/identity/src/api/{index.ts,api-surface.spec.ts}`
  (`tenantMemberCacheKey`), `domains/identity/README.md`, `docs/ARCHITECTURE.md` (cache section).
- **Interfaces.** Contract: `tenantCacheKey`, `tenantMemberCacheKey`, `UserReadCache`. `getScopedUser(id, tenantId)`
  is called with the caller's `AuthUser.tenantId` only:
  1. Marker: `getOrSet(tenantMemberCacheKey(tenantId, id), loader, USER_CACHE_TTL_MS)`. The loader is
     `users.getUser(id, { tenantId })` (404 outside the tenant) and stores `true`; a rejected loader caches nothing.
  2. Then the profile under `user:<id>`, filled from the loader's result: a cold scoped read costs one port call,
     a warm one none. `user:<id>` is never read for another user before the marker exists.
  3. `invalidateMembership` deletes the marker in both tiers and on every replica's L1.
- **Acceptance tests.**
  - `tenant-cache-key.spec.ts` (neutral words): `tenantCacheKey('orders', T, 'item', 7)` is `orders:<t>:item:7`; an
    upper-case tenant id is lower-cased; it throws for a non-UUID tenant, the nil UUID, the scopes `Orders`, `a:b`
    and `''`, no parts, an empty part and a part containing `:`; two tenants never share a key for equal parts.
  - `user-read.cache.spec.ts` (the in-memory app cache and a fake `UsersPort` that knows memberships): an admin of
    A reads member V with one port call, then none; an admin of B reads V right after (warm `user:<V>`) and gets
    404, the port was asked with `{ tenantId: B }`, and a second attempt asks again (nothing cached for the pair);
    after V leaves A and `invalidateMembership(A, V)`, A's admin gets 404; a port error other than 404 propagates
    and caches nothing; `getUser(self)` never reads a marker.
  - The member HTTP and GraphQL specs: remove and leave call `invalidateMembership(tenant, user)` once on
    success and never on failure.
- **Dependencies.** B2 core Task 12; B2 edge Task 8; Task 2 (same lane). **Lane.** I. **Review:** yes.

### Task 8: Storage keys under `tenants/<tid>/users/<uid>/` and the `files:manage` re-grant (B4-3)

- **Goal.** Objects live under `tenants/<tid>/users/<uid>/<uuidv7>/<safeFilename>`. Presign, download and delete
  check the tenant prefix first, then ownership, then `files:manage`, which now means "any file of my active
  tenant" and is granted to admins again in this same commit (B2 I-5 withheld it until keys carried the tenant).
  The inventory's dependency on B3-9 does not apply: the files domain has no Postgres, and "elevation" here is the
  TypeScript permission check, which never crosses the tenant prefix.
- **Files.** Modify in `domains/files/src`: `files.constants.ts`,
  `application/{file-key,file-access.policy,files.service,files.types}.ts`, `files.permissions.ts`,
  `presentation/http/{files.controller,files.dto}.ts`, `presentation/graphql/files.resolver.ts`, the specs beside
  them, `testing/files-test-app.test.ts`; `domains/files/README.md` (key format, the legacy move command),
  `docs/API.md` (files), `docs/SECURITY.md` and `README.md` (the RBAC matrix row). Flip every spec and comment that
  pins the withheld state: `rg 'withheld until B4-3' -g '!docs/superpowers/**'`.
- **Interfaces.** Contract: `FileActor`, the three builders, `resolveFileAccess`. Decision order:
  1. `assertStorageKey(key)` (422 `INVALID_STORAGE_KEY`).
  2. Not strictly under `tenantFilesPrefix(actor.tenantId)` → `'denied'`: every legacy `users/…` key and every
     other tenant's key, whatever the permissions.
  3. Strictly under `userFilesPrefix(actor.tenantId, actor.id)` → `'owner'`.
  4. The actor holds `FilesPermission.Manage` → `'manager'` (logged with tenant, actor and key).
  5. Otherwise `'denied'`.
     The tenant segment must be a UUID and not `PLATFORM_TENANT_ID`; the user segment keeps today's rule (one
     non-empty segment). `filenameOfFileKey` returns the last segment. Uploads add the metadata `tenant-id`.
- **Acceptance tests.**
  - `file-key.spec.ts`: `buildUserFileKey(T, U, name, ID)` is `tenants/<T>/users/<U>/<ID>/<safe name>`; it throws
    for an empty, slashed, non-UUID or nil tenant; `filenameOfFileKey` returns the name for the new shape.
  - `file-access.policy.spec.ts` (one table): own key → owner; same tenant, other user → denied without
    `files:manage`, manager with it; the same user's key in tenant B while acting in A → denied, also with
    `files:manage`; legacy `users/<U>/x` → denied for its uploader and for a manager; `tenants/<A>/../<B>/users/…`
    → `INVALID_STORAGE_KEY`; the bare prefixes `tenants/<A>` and `tenants/<A>/users/<U>` → denied; a tenant id that
    extends A's by one character → denied.
  - `files.service.spec.ts`: upload and presigned-upload keys start with the caller's
    `tenants/<tid>/users/<uid>/`; download-url and delete of another tenant's existing key throw
    `FileAccessDeniedException` before `storage.head` or `storage.delete` is called; the manager log line names
    the tenant.
  - `files.permissions.spec.ts`: `FILES_RBAC.grants.admin` contains `files:manage`, `member` does not; the
    withheld-state test is gone.
  - HTTP and GraphQL specs: an admin of A presigns and deletes another member's file in A; an admin of B gets
    403 on that key; B2's two "files:manage is withheld until B4-3" tests are rewritten to these.
- **Dependencies.** B2 core Tasks 2, 10. No B3. **Lane.** F (wave 1). **Review:** yes.

### Task 9: Cross-tenant isolation e2e in both topologies (B4-7)

- **Goal.** One suite per topology harness proves at the REST and GraphQL edge that two tenants cannot see each
  other's payments, notifications or files, with the hard case in every store: one user who is a member of both.
  The harness stores must hold state for that to mean anything, so the monolith binds the in-memory notifications
  repositories in place of the Cassandra fake that answers every query with no rows. The task also makes the one
  production edit that needs B3 (the digest cron runs in `SystemContext`) and writes the docs.
- **Files.** Create `apps/monolith/test/tenant-isolation.e2e-spec.ts`,
  `apps/gateway/test/tenant-isolation.e2e-spec.ts`. Modify `apps/monolith/test/support/monolith-e2e-app.ts`
  (override `NotificationsRepository` and `NotificationRecipientsRepository` with the in-memory ones and return
  them), `apps/gateway/test/support/gateway-e2e-app.ts` if a fixture helper is needed,
  `domains/notifications/src/infrastructure/scheduling/daily-digest.cron.{ts,spec.ts}` (wrap the command in
  `SystemContext.run('notifications.daily-digest', …)`), `docs/SECURITY.md` (new
  section "Tenant isolation outside Postgres": the key-format table, the tenant-source rule, what a tenant switch
  guarantees), `docs/TESTING.md` (the list below), `docs/ARCHITECTURE.md`, `README.md` (one
  `docker compose down -v` after B4; test counts).
- **Interfaces.** None new. Where each store's proof lives: Postgres payments, B3 Task 19 on real Citus (here only
  the edge wiring); Cassandra, the int specs of Tasks 3 and 4 on real Cassandra (here the real handlers over
  in-memory repositories in the monolith, the tenant-keyed `FakeNotificationsPort` in the gateway); storage, the
  real `FilesService` over `InMemoryStorageService`; cache, the real `AppCacheService` L1 tier. Precondition: the
  gateway's `FakeAuthPort.switchTenant` (B2 core Task 14) denylists the presented access token as the real handler
  does; if it does not, fix the fake here (Tasks 10 and 11 rely on it).
- **Acceptance tests.** Both files, same cases. Fixtures through the real flows (register, invite, accept, login,
  switch), never hand-signed tokens: U owns tenant A and is an admin of tenant B; W owns B; V is an admin of A
  only (if an invitation can only grant `member`, the owner promotes the invitee through B2-13's role change).
  1. Notifications: n1 for (A,U), n2 for (B,U), n3 for (A,V). U with A's token: `GET /v1/notifications` and the
     GraphQL `notifications` query return exactly `[n1]`; marking n2 read is 404 and n2 stays unread; after
     `switch-tenant` to B the list is exactly `[n2]` and the old token is 401.
  2. Files: U uploads f in A; its key starts with `tenants/<A>/users/<U>/`. With B's token U gets 403 on
     download-url and on delete, and the object is still stored; W (owner of B, so `files:manage`) gets 403; V gets a
     download URL; a legacy key `users/<U>/x` put straight into storage is 403 for U and for V.
  3. Payments: U has p1 in A and p2 in B. With A's token the listing returns p1 only, `all=true` as V returns A's
     payments only, and B's token never returns p1. Monolith: the fake Postgres answers by the tenant parameter,
     and the spec asserts every executed payments statement bound the token's tenant; gateway: B2-27's fakes.
  4. User cache: V reads U's profile in A twice (the second from the cache); W then reads V and gets 404 while V
     is still cached for A; U, acting in B, reads W and gets 200.
  5. `daily-digest.cron.spec.ts`: while the command runs, `SystemContext.isActive()` is true, `getPrincipal()` is
     undefined and the reason is `notifications.daily-digest`.
- **Dependencies.** Tasks 3-8; B2 edge Tasks 12, 13; B3 merged. **Lane.** Q. **Review:** no.

### Task 10: Real Socket.IO spec (E-1, AUDIT-F10)

- **Goal.** The first specs that reach the Socket.IO gateway over a real connection: socket.io-client against a
  listening app, covering the handshake, per-message guards, acks, pushes, tenant rooms, expiry and revocation,
  including a real tenant switch. The full suite runs on the monolith harness (real notifications core); a reduced
  suite (the cases marked G) runs on the gateway harness, the Socket.IO host of the microservices topology.
- **Files.** Create `libs/testing/src/realtime/{index.ts,listen-on-loopback.ts,socket-client.ts}`,
  `apps/monolith/test/realtime-socket.e2e-spec.ts`, `apps/gateway/test/realtime-socket.e2e-spec.ts`. Modify the
  root `package.json` catalog (`socket.io-client`: the controller reads `npm view socket.io-client versions` and
  pins the 4.8 release that matches the pinned `socket.io` 4.8.4; do not guess it), `libs/testing/package.json`
  (`exports` gains `./realtime`; `dependencies` gain `socket.io-client` and `graphql-ws`, both `catalog:`;
  controller `bun install`), `libs/testing/README.md`, `docs/TESTING.md`.
- **Interfaces.** `listenOnLoopback`. The spec files set `WS_REVOCATION_SWEEP_INTERVAL_MS=200` before the app
  boots. No Kafka and no Redis adapter are connected: a push is driven by calling
  `app.get(NotificationPushConsumer).onNotificationCreated(envelope)` with an envelope from `createEventEnvelope`.
  Fan-out across replicas through the Redis adapter is not covered (one process). C11's socket caps are not
  asserted (C12 owns C's e2e); if C11 merged first, the spec sets its limits high.
- **Acceptance tests.**
  - Handshake (G): no token → `connect_error` with `data.code` `MISSING_TOKEN`; expired → `TOKEN_EXPIRED`;
    denylisted → `TOKEN_REVOKED`; garbage → `INVALID_TOKEN`; `auth.token` and the `Authorization` header both
    connect; a token in the query string does not.
  - Messages: `ping` answers `pong` with an ISO `ts`; `notifications.markRead` on an own notification acks
    `{ ok: true }` and the inbox shows it read; an unknown id acks `{ ok: false, error }` with status 404; a
    malformed body acks 400; exceeding the `notifications.mark-read` policy acks 429; an error without an ack
    callback arrives as an `exception` event.
  - Push and rooms (G): an envelope for (A,U) reaches U's socket connected with A's token exactly once, with the
    REST notification shape; U's second socket connected with B's token and V's socket in A receive nothing within
    300 ms; the same envelope id delivered again pushes nothing; an envelope without `tenantId` rejects and pushes
    nothing.
  - Expiry: a socket whose token expires in 2 s receives `exception` `TOKEN_EXPIRED`, then disconnects with the
    reason `io server disconnect`.
  - Revocation (G): after `POST /v1/auth/logout` the socket receives `exception` `TOKEN_REVOKED` and disconnects
    within two sweep intervals; a message sent before the sweep is refused with 401 `TOKEN_REVOKED`.
  - Tenant switch (G): U connects with A's token and calls `POST /v1/auth/switch-tenant` for B: that socket
    receives `TOKEN_REVOKED` and disconnects within two sweep intervals; a socket opened with the returned token
    receives a (B,U) push and no (A,U) push; U's other session (a second login in A) keeps its socket.
  - Teardown: every client is closed and `app.close()` resolves without a pending handle.
- **Dependencies.** Tasks 5, 9; C6 (merged). **Lane.** Q. **Review:** no.

### Task 11: Real graphql-ws spec (E-2, AUDIT-F11)

- **Goal.** `createClient` from `graphql-ws` against a listening app: `connection_init` authentication, delivery,
  the 4401 and 4403 closes, the tenant and user filters, the jti sweep including a tenant switch, and the
  complexity check on the WebSocket path.
- **Files.** Create `libs/testing/src/realtime/graphql-ws-client.ts` (a client on Node 24's global `WebSocket`, a
  promise for the close event `{ code, reason }`, a collector for `next` messages),
  `apps/monolith/test/realtime-graphql.e2e-spec.ts`, `apps/gateway/test/realtime-graphql.e2e-spec.ts`. Modify
  `libs/testing/src/realtime/index.ts`, `libs/testing/README.md`, `docs/TESTING.md`.
- **Interfaces.** None new; pushes are driven as in Task 10, the sweep interval is 200 ms. Not covered: the 10 s
  `connection_init` timeout (4408) and C11's caps.
- **Acceptance tests.** Both files:
  - Connection: no token → close 4403; an invalid, an expired and a denylisted token → 4403;
    `{ authorization: 'Bearer …' }` and `{ token }` are both acknowledged.
  - Delivery: after `subscription { notificationCreated { id title } }`, an envelope for (A,U) yields exactly one
    `next` with that id.
  - Filters: pushes for (B,U) and (A,V) yield no `next` within 300 ms; a payload for (B,U) published straight to
    `GRAPHQL_PUB_SUB` on the (A,U) trigger yields none.
  - Guards on the socket: the query `{ notifications { items { id } } }` sent over the socket returns tenant A's
    inbox only.
  - Expiry: a token expiring in 2 s → close 4401 `Access token expired`.
  - Sweep: logout → close 4401 `Access token revoked` within two intervals; a tenant switch closes the old-token
    connection the same way, a second connection of that user under another jti stays open, and a new connection
    with the new token receives (B,U) pushes only.
  - Complexity: an operation above `GRAPHQL_MAX_COMPLEXITY` sent on the socket returns an error with the code
    `QUERY_TOO_COMPLEX`, and the socket serves the next operation.
- **Dependencies.** Tasks 1, 6, 10; C10 (complexity case). **Lane.** Q. **Review:** no.

## Spec deltas (the default taken; the controller may overrule before the wave starts)

1. **Disconnect on tenant switch is by token, not by room.** The denylisted jti plus the sweep closes the
   switching token's sockets within the interval. A socket opened with an earlier, still valid access token of the
   same session lives until that token expires (it is equally valid over HTTP until then). Alternative: an
   `identity.tenant-switched.v1` event and a room-wide `disconnectSockets` at the edge: immediate, but it also
   closes the user's other devices in the old tenant, and it is best effort until the outbox (G-1) exists.
2. **Membership events (Task 2) are not in the inventory.** Without them a recipients row exists only for the
   personal workspace, and receipts and digests are never mailed in a joined tenant. Alternative: drop Task 2's
   two new events and accept that; Task 3 then feeds recipients from `user-registered` only.
3. **No backfill.** The user-keyed Cassandra tables are dropped and legacy storage keys become unreachable; dev
   resets its volumes. Alternative: a one-off tool that maps each user to their personal workspace.
4. **Scoped user reads are cached again** behind a membership marker. If a removal bypasses the invalidating edge
   or Redis is down, a removed member stays readable in that tenant for at most `USER_CACHE_TTL_MS` (30 s).
   Alternative: keep B2's bypass; Task 7 then ships only the builder.
5. **`WS_REVOCATION_SWEEP_INTERVAL_MS` becomes an env key** of the auth namespace (100..300000 ms), and the
   constant leaves the notifications `./api` surface that G pinned. A live graphql-ws socket whose token is revoked
   closes with 4401, the code already used for expiry, with its own reason.
6. **`notifications.v1` requests gain `tenant_id`** (the billing pattern of B2-26) although the principal is the
   source; the field exists only to be compared.
7. **Not covered by any spec here:** fan-out across replicas through a real Redis adapter, and staff switch-out
   (its sockets close by the same sweep, since switch-out denylists the token).
8. **Unprobed** (no container was started while planning): how Cassandra 5.0.9 treats a paging state replayed on
   another partition (Task 4 accepts a rejection or same-partition rows), and the exact `socket.io-client` release.

## Rulings (controller, 2026-11-16, auto-run)

1. Disconnect on tenant switch: keep the default. The denylisted token plus the sweep close that token's sockets
   within `WS_REVOCATION_SWEEP_INTERVAL_MS`. Switching does not end the old membership, so a socket still in the
   old tenant's room is not a cross-tenant leak, and removal flows revoke on their own. There is no room-wide close.
2. Keep the two new events, `identity.membership-created.v1` and `identity.membership-removed.v1`.
3. No backfill. Dev data is reset, and the docs describe the manual move for adopters with real data.
4. **Task 7 deviates from the plan's default:** keep B2's cache bypass for scoped user reads and ship only the
   `tenantCacheKey` builder and the tenant-scoped key formats. Drop the per-tenant membership marker re-check, so
   a removed member is never readable from cache. The docs note how a deployment could opt into the marker cache.
