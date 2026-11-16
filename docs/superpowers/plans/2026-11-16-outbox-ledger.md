# Phase G-outbox and ledger waves 1-2 implementation plan: transactional outbox, relay, postings, reconciliation

> Light plan (process rules of 2026-11-16): goals, files, interfaces, acceptance tests. Signatures are binding.

## Header

- **Goal.** Every integration event of a Postgres domain is written to `<schema>.outbox` in the transaction that changes state and reaches Kafka at least once through one leader relay per domain; on that carrier, Stripe money movements are posted to the immudb ledger exactly once in effect, reconciled hourly (R1-R5) and verified against a trusted state held in Postgres.
- **Architecture.** A new platform package `@platform/outbox` (table type, runtime writer, system repository base, relay, metrics) names no domain; identity and billing each own their outbox table, migration, policy and a thin system repository. Billing owns the five ledger tables, the `billing.ledger-posting.v1` contract, the webhook coverage, `LedgerService`, `LedgerPostingConsumer`, the reconciliation cron and the trusted-state advance. Notifications (Cassandra) and files (no store) get no outbox.
- **Spec paths (binding).** `docs/superpowers/specs/2026-11-09-stripe-ledger-immudb-design.md` §2.4, §2.5, §3-§8, "Interface contracts", "Decisions" ("LG §n"); `docs/superpowers/specs/2026-11-09-sharding-citus-pgbouncer-design.md` §2.1, §2.3, §4.2, §7.4 ("SH §n"); `docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md` §8.2, §9, §12, §16 ("spec §n"). Contracts consumed: `2026-11-16-b3-rls.md` Interfaces ("B3"), `2026-11-09-b2-edge.md` Tasks 1, 2, 4 ("B2e"), `2026-11-09-ledger-wave0.md` L-5, L-7, L-8a/b, L-9 ("W0"), `2026-11-09-g-metrics-packaging.md` Tasks 7, 9 ("GM"), `2026-11-09-c-rate-limiting.md` Interface contracts ("C"); `program-work/conventions.md` §4.4-§4.8, §4.11.
- **Upstream state.** Executes after B3 has merged into `feat/domains-tenancy`, and after W0 (L-1..L-9), GM Tasks 6-10 and C wave 2. None of them is in the tree this plan was written against (no `libs/immudb`, billing has only `0000_init`, no `metric-registry.ts`, no `rate-limit-charger.ts`): upstream names come from those plans' Interfaces; where merged code differs, the merged code wins and the implementer says so in the commit body. Migration indexes: the next free `NNNN` per set at merge time.

### Global Constraints (one line each)

- Node: prefix `node`, `bun`, `npx` with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 24.4.0 >/dev/null;`.
- Search with `rg`, `fd`, `jaq`; `grep`, `find`, `jq` are blocked.
- One GPG-signed commit per task, commitlint-clean, no attribution lines; never push, never merge to `master`. Scope `outbox` exists once `libs/outbox/package.json` does.
- Gates before each commit: `bun run check`, the task's specs, `bun run db:check` after a migration task, `node scripts/check-env-example.mjs` after an env change, `node scripts/docker/check-kafka-topics.mjs` after a topic change; the full gate (`bun run test`, the `:int` projects) ends each wave.
- Int specs need Docker with the sandbox off: Postgres only through `startRlsTestPostgres()` (local execution off), immudb through a Testcontainer of `IMMUDB_TEST_IMAGE`, Redis as the existing lock int specs do; never the developer's compose project.
- Migrations: never edit a committed file; a new table's file is drizzle-generated, then hand-edited in the order CREATE → `app.distribute_by_tenant` (tenant tables only) → indexes → ENABLE and FORCE RLS → grants → policies; one statement per `GRANT` and per policy; no subquery in a policy; no FK on any table of this plan.
- Billing migrations stay serialized on lane DB in the order G-1 (Task 6) → L-10 (Task 10); identity's on lane DI.
- Every statement on a distributed table carries `tenant_id = $n` (router), except the named multi-shard system reads and purges; no row lock across shards; no session state behind PgBouncer.
- The runtime role on insert-only tables: plain `INSERT`, no `RETURNING`, no read-then-insert (Interfaces, "Insert-only rule").
- The system pool is reached only from `*.system-repository.ts`; every method is in its domain's pinned list; a `system` method runs inside `SystemContext.run('<domain>.<job>', …)`.
- No Stripe, Kafka or immudb call while a Postgres transaction is open; one principal per transaction (B3).
- Money is `bigint` minor units in TypeScript; no PII in immudb, in discrepancy JSON, in logs of this plan or in metric labels.
- `libs/` names no domain, also in specs and fixtures (`scripts/libs-vocabulary.spec.ts`).
- Controller only: `bun install` (the new workspace package, Task 1), lane merges (`git merge --no-ff -S` after `git merge-tree`), the final review.

### Review Focus (the phase's one final review, `code-review high`; per-task reviews only where `review: yes`)

1. The outbox row commits or rolls back with the state change, in every flow of Tasks 5, 6, 12; nothing publishes to Kafka from a request path any more.
2. The relay: one leader per outbox, no Postgres transaction open across a publish, rows marked only after the broker acknowledged, every failure path ends in a resend and never in a loss.
3. Exactly-once effect of postings: deterministic entry ids, replay and conflict handling, receipts under the insert-only rule; a redelivery or a concurrent duplicate never yields a second entry or ref.
4. Tenant checks: the consumer's principal comes from the envelope and must match the payload; `PLATFORM_TENANT_ID` posts, reads and rows only inside `SystemContext`; the pinned system-method lists match spec §9 plus the deltas named here.
5. Reconciliation appends and never corrects; overlapping windows add no duplicate finding; each kind has a fixture that produces it and a clean fixture that does not.
6. R5: the trusted state advances only after the dual proof (and the signature, when a key is pinned) verified, by compare-and-set; a failed proof leaves it untouched; production refuses an unverified ledger.

## Interfaces (contract of this plan)

Consumed by B4, E (topology smoke), the G-13 docs and the final squash. W0's ledger types and `LedgerPort` are unchanged.

<!-- prettier-ignore -->
```ts
// ── @platform/config: platform namespace `outbox` (Task 1) ─────────────────────────────────────────────────────
// OUTBOX_RELAY_ENABLED → relayEnabled (bool, true)             OUTBOX_POLL_INTERVAL_MS → pollIntervalMs (50..60000, 500)
// OUTBOX_BATCH_SIZE → batchSize (1..500, 100)                  OUTBOX_LOCK_TTL_MS → lockTtlMs (1000..300000, 15000)
// OUTBOX_MAX_BACKOFF_MS → maxBackoffMs (≥ poll interval, 30000) OUTBOX_RETENTION_HOURS → retentionHours (1..8760, 168)
// ── @platform/transport (Task 1) ───────────────────────────────────────────────────────────────────────────────
// KafkaProducer#publishStored(topic: string, envelope: EventEnvelope<unknown>, key: string | null): Promise<void>
//   Sends an envelope validated when it was stored: checks the generic envelope schema and envelope.type === topic,
//   rebuilds the two headers from it, reads nothing from CLS, changes no field. Errors as publish(); the fake records it.
// ── @platform/outbox (Tasks 1-4) ───────────────────────────────────────────────────────────────────────────────
export type OutboxTable = /* a drizzle pg table with exactly the columns of "Outbox table" below */;
export interface OutboxFeature { readonly name: string; readonly table: OutboxTable } // name = the pg schema: lock, label
export interface OutboxRecord { readonly tenantId: string; readonly id: string; readonly topic: string;
  readonly key: string | null; readonly envelope: EventEnvelope<unknown> } // id = envelope.id, tenantId = envelope.tenantId
export interface OutboxRow extends OutboxRecord { readonly createdAt: Date }
export class OutboxError extends Error { readonly code: 'OUTBOX_NO_TRANSACTION' | 'OUTBOX_TENANT_REQUIRED' | 'OUTBOX_TENANT_MISMATCH' | 'OUTBOX_PLATFORM_TENANT' }
export abstract class OutboxWriter { // each domain subclasses it once; the subclass is the DI token
  /** A validated record, no SQL. tenantId, actorId and correlationId default as KafkaProducer.createRecord (B2e Task 4). */
  record<T>(contract: EventContract<T>, payload: NoInfer<T>, options?: KafkaPublishOptions): OutboxRecord;
  /** record() + one plain INSERT in the caller's OPEN transaction (it never opens one); the row's tenant is the principal's. */
  enqueue<T>(contract: EventContract<T>, payload: NoInfer<T>, options?: KafkaPublishOptions): Promise<EventEnvelope<T>>;
}
export const OUTBOX_SYSTEM_METHODS: { readonly poll: SystemMethod; readonly markPublished: SystemMethod;
  readonly insertAsPlatform: SystemMethod; readonly deletePublishedBefore: SystemMethod }; // scope 'system'; names:
//   'outbox.pollUnpublished', 'outbox.markPublished', 'outbox.insertAsPlatform', 'outbox.deletePublishedBefore'
export interface OutboxPoll { readonly rows: readonly OutboxRow[]; readonly backlog: number; readonly oldestCreatedAt: Date | null }
export abstract class OutboxSystemRepository { // libs/outbox/src/outbox.system-repository.ts; each domain subclasses it once
  pollUnpublished(limit: number): Promise<OutboxPoll>;       // multi-shard, no row lock, ORDER BY created_at, id; + backlog stats
  markPublished(rows: readonly Pick<OutboxRecord, 'tenantId' | 'id'>[]): Promise<number>; // router statements only
  insertAsPlatform(records: readonly OutboxRecord[]): Promise<number>; // PLATFORM_TENANT_ID rows only; ON CONFLICT DO NOTHING
  deletePublishedBefore(cutoff: Date): Promise<number>;      // multi-shard DELETE of published rows
}
export interface OutboxTickResult { readonly polled: number; readonly published: number; readonly failed: boolean }
export class OutboxRelay { // one per feature; starts on bootstrap when relayEnabled and a system pool exists
  tick(signal: AbortSignal): Promise<OutboxTickResult>;                    // one poll → publish → mark cycle
  runTerm(stop: AbortSignal): Promise<'not-leader' | 'lost' | 'stopped'>;  // one term on the lock `outbox-relay:<name>`
}
export class OutboxModule { static forFeature(options: { feature: OutboxFeature; writer: Type<OutboxWriter>;
  systemRepository: Type<OutboxSystemRepository> }): DynamicModule } // provides and exports both; owns one relay
// @platform/outbox/testing: InMemoryOutbox (writer + system repository over one array; `records`, `unpublished()`),
//   describeOutboxTable(table: unknown, schema: string): void (the shape spec every domain's schema spec calls)
// ── @domain/identity and @domain/billing root barrels (Tasks 5, 6) ─────────────────────────────────────────────
export class IdentityOutbox extends OutboxWriter {}  export const IDENTITY_OUTBOX: OutboxFeature; // name 'identity'
export class BillingOutbox extends OutboxWriter {}   export const BILLING_OUTBOX: OutboxFeature;  // name 'billing'
// ── @domain/billing-contracts (Task 12) ────────────────────────────────────────────────────────────────────────
export const LEDGER_POSTING_REQUESTED_EVENT: EventContract<LedgerPostingRequestedPayload>; // 'billing.ledger-posting.v1',
//   tenantScoped; payload = LG "Interface contracts" field for field (tenantId a uuid incl. the nil one; userId, paymentId uuid | null)
// ── @domain/billing root barrel (Tasks 11-13, 15) ──────────────────────────────────────────────────────────────
// domain namespace `ledger` (Task 12): LEDGER_ENABLED → enabled (false), LEDGER_RECONCILE_LOOKBACK_HOURS → reconcileLookbackHours (72),
//   LEDGER_VERIFY → verify (false), LEDGER_ALLOW_UNVERIFIED → allowUnverified (false; Task 17)
export type LedgerDiscrepancyKind = 'unbalanced_entry' | 'unbalanced_currency' | 'ledger_row_mutated' | 'payment_without_entry'
  | 'entry_without_payment' | 'amount_mismatch' | 'tenant_mismatch' | 'status_mismatch' | 'missing_entry' | 'stripe_amount_mismatch'
  | 'fee_unavailable' | 'tenant_unresolved' | 'verification_failed' | 'post_conflict' | 'resolved';
export type LedgerDetector = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'consumer';
export interface LedgerDiscrepancyInput { readonly tenantId: string; readonly kind: LedgerDiscrepancyKind; readonly sourceKey: string;
  readonly expected: Readonly<Record<string, string | number | null>>; readonly actual: Readonly<Record<string, string | number | null>>;
  readonly detectedBy: LedgerDetector; readonly runId: string | null } // amounts as decimal strings
/** uuidv5(LEDGER_NAMESPACE, 'discrepancy:' + kind + ':' + sourceKey + ':' + sha256(canonicalJson({ expected, actual }))) */
export function ledgerDiscrepancyId(input: Pick<LedgerDiscrepancyInput, 'kind' | 'sourceKey' | 'expected' | 'actual'>): string;
export interface LedgerEntryRef { readonly tenantId: string; readonly entryId: string; readonly sourceKey: string;
  readonly payloadHash: string; readonly immudbTxId: bigint | null; readonly paymentId: string | null;
  readonly kind: LedgerEntryKind; readonly postedAt: Date }
export interface LedgerAccountRef { readonly tenantId: string; readonly code: LedgerAccountCode; readonly currency: string; readonly immudbAccountId: string }
export interface LedgerCursor { readonly tenantId: string; readonly id: string }
export interface PaidPaymentRow { readonly tenantId: string; readonly id: string; readonly userId: string; readonly status: PaymentStatus;
  readonly amountTotal: bigint | null; readonly currency: string | null; readonly paidAt: Date }
export interface LedgerRunCounts { readonly found: Readonly<Record<string, number>>; readonly appended: Readonly<Record<string, number>> }
export abstract class LedgerReceiptsRepository { // runtime role, as the principal; each call is its own unit of work
  abstract recordEntryRef(ref: LedgerEntryRef): Promise<boolean>;          // false: already recorded
  abstract recordAccounts(rows: readonly LedgerAccountRef[]): Promise<void>; // tenant-owned rows only; idempotent
  abstract appendDiscrepancy(row: LedgerDiscrepancyInput): Promise<boolean>; // false: the identical finding exists
}
export abstract class LedgerSystemRepository { // scope 'system'; SystemMethod names in the comments (spec §9 items 9-11)
  abstract listSucceededPayments(from: Date, to: Date, after: LedgerCursor | null, limit: number): Promise<readonly PaidPaymentRow[]>; // ledgerReconciliation.listSucceededPayments
  abstract listEntryRefs(from: Date, to: Date, after: LedgerCursor | null, limit: number): Promise<readonly LedgerEntryRef[]>;       // ledgerReconciliation.listEntryRefs
  abstract appendDiscrepancies(rows: readonly LedgerDiscrepancyInput[]): Promise<number>; // ledgerReconciliation.appendDiscrepancies; new rows
  abstract enqueueMissingPostings(records: readonly OutboxRecord[]): Promise<number>;     // ledgerReconciliation.enqueueMissingPostings
  abstract recordEntryRefs(rows: readonly LedgerEntryRef[]): Promise<number>;             // ledgerEntryRefs.recordAsSystem
  abstract recordPlatformAccounts(rows: readonly LedgerAccountRef[]): Promise<number>;    // ledgerAccounts.recordPlatformAccounts (delta 4)
  abstract readTrustedState(database: string): Promise<(LedgerTrustedState & { readonly verifiedAt: Date }) | null>; // ledgerTrustedState.read
  abstract advanceTrustedState(database: string, from: LedgerTrustedState | null, to: LedgerTrustedState): Promise<boolean>; // ledgerTrustedState.advance (compare-and-set)
  abstract startRun(run: { readonly id: string; readonly from: Date; readonly to: Date }): Promise<void>;                    // ledgerRuns.start
  abstract finishRun(id: string, status: 'succeeded' | 'failed', counts: LedgerRunCounts): Promise<void>;                    // ledgerRuns.finish
}
@Injectable() export class LedgerService { // the only caller of LedgerPort.post/getEntry/balances; "Ledger tenant rule" below
  post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome>; // @throws LedgerTenantMismatchException (LEDGER_TENANT_MISMATCH, 403),
  getEntry(entryId: string): Promise<LedgerEntry | null>;    //         LedgerDisabledException (LEDGER_DISABLED, 503)
  balances(currency?: string): Promise<readonly LedgerBalance[]>;
}
export class PostLedgerEntryCommand { constructor(readonly draft: LedgerEntryDraft) }                    // → LedgerPostOutcome
export class ProcessLedgerPostingCommand { constructor(readonly request: LedgerPostingRequestedPayload) } // → void
export class ReconcileLedgerCommand { constructor(readonly window?: { readonly from: Date; readonly to: Date }) } // → LedgerRunCounts
export interface ReconciliationCheck { readonly name: Exclude<LedgerDetector, 'consumer'>;
  run(ctx: { readonly runId: string; readonly from: Date; readonly to: Date }): Promise<readonly LedgerDiscrepancyInput[]> }
```

**Outbox table** (Tasks 5, 6; `<s>` = `identity` or `billing`; the SQL every outbox migration must end up with):

<!-- prettier-ignore -->
```sql
CREATE TABLE "<s>"."outbox" ("tenant_id" uuid NOT NULL, "id" uuid NOT NULL, "topic" text NOT NULL, "key" text,
  "envelope" jsonb NOT NULL, "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp (3) with time zone, CONSTRAINT "outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"));
SELECT app.distribute_by_tenant('<s>.outbox');
CREATE INDEX "outbox_unpublished_idx" ON "<s>"."outbox" ("created_at","id") WHERE "published_at" IS NULL;
CREATE INDEX "outbox_published_at_idx" ON "<s>"."outbox" ("published_at") WHERE "published_at" IS NOT NULL;
ALTER TABLE "<s>"."outbox" ENABLE ROW LEVEL SECURITY;   ALTER TABLE "<s>"."outbox" FORCE ROW LEVEL SECURITY;
GRANT INSERT ON "<s>"."outbox" TO app_runtime;          GRANT SELECT, INSERT, UPDATE, DELETE ON "<s>"."outbox" TO app_system;
CREATE POLICY "outbox_insert" ON "<s>"."outbox" FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id());
```

**Ledger tables** (Task 10; schema `billing`; every table has `created_at timestamptz(3) NOT NULL DEFAULT now()`; no FK;
all five ENABLE and FORCE RLS; policies `<table>_select` / `<table>_insert` `TO app_runtime`):

| Table (Citus kind)               | Columns                                                                                                                                                                                                 | PK                            | Grants runtime / system | SELECT `USING`                                   | INSERT `WITH CHECK`           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------- | ------------------------------------------------ | ----------------------------- |
| `ledger_accounts` (T)            | `tenant_id uuid`, `code text`, `currency text`, `immudb_account_id uuid NOT NULL`                                                                                                                       | `(tenant_id, code, currency)` | S, I / S, I             | `tenant_id = app.tenant_id() AND app.elevated()` | `tenant_id = app.tenant_id()` |
| `ledger_entry_refs` (T)          | `tenant_id uuid`, `entry_id uuid`, `source_key text`, `payload_hash text`, `immudb_tx_id bigint` (nullable), `payment_id uuid` (nullable), `kind text`, `posted_at timestamptz(3)`; index `(posted_at)` | `(tenant_id, entry_id)`       | S, I / S, I             | same                                             | same                          |
| `ledger_discrepancies` (T)       | `tenant_id uuid`, `id uuid`, `kind text`, `source_key text`, `expected jsonb`, `actual jsonb`, `detected_by text`, `run_id uuid` (nullable), `resolves_id uuid` (nullable)                              | `(tenant_id, id)`             | S, I / S, I             | same                                             | same                          |
| `ledger_reconciliation_runs` (L) | `id uuid`, `from_ts`, `to_ts timestamptz(3)`, `status text`, `counts jsonb`, `finished_at timestamptz(3)` (nullable)                                                                                    | `(id)`                        | none / S, I, U          | no policy                                        | no policy                     |
| `ledger_trusted_state` (L)       | `database text`, `tx_id bigint`, `tx_hash bytea`, `verified_at timestamptz(3)`                                                                                                                          | `(database)`                  | none / S, I, U          | no policy                                        | no policy                     |

**Rules that cross tasks.**

- **Insert-only rule.** The runtime role cannot read `outbox` (no SELECT grant) and reads the ledger tables only when
  elevated, which the consumer's `roles: []` principal never is. Runtime inserts are therefore plain `INSERT`s without
  `RETURNING`; an idempotent one (`recordEntryRef`, `recordAccounts`, `appendDiscrepancy`) uses the form Task 10's probe
  pins: `ON CONFLICT DO NOTHING` without a conflict target, or else one statement per unit of work with SQLSTATE `23505`
  mapped to "already there". `OutboxWriter.enqueue` never dedupes: a duplicate id fails the business transaction.
- **Envelope ids.** `outbox.id` = envelope id. Domain events: the domain event's id. Webhook postings:
  `uuidv5(LEDGER_NAMESPACE, <Stripe event id>)`, key = tenant id. R4 re-enqueues:
  `uuidv5(LEDGER_NAMESPACE, 'reconcile:' + runId + ':' + txnId)` with `stripeEventId = 'reconcile:' + runId`,
  `stripeEventType = 'reconcile.missing_entry'`, `objectType = 'balance_transaction'`, `objectId = txnId`.
- **Stripe owner.** One resolver (Task 12): the object's own metadata (`stripeOwnerOf`, B2e Task 1), else the metadata
  of its PaymentIntent (one GET, before the unit of work); otherwise `PLATFORM_OWNER` with `unresolved: true`.
- **Ledger tenant rule** (`LedgerService`). With a CLS principal: the draft's or read's tenant must equal
  `principal.tenantId` and is never `PLATFORM_TENANT_ID` (lines may still use platform-owned accounts, W0
  `assertBalanced`). Inside `SystemContext` (no principal): any tenant, including the platform tenant. Neither: refused.
- **`LEDGER_ENABLED=false`** (the default): webhooks still record receipts and payment transitions but write no
  posting row; the consumer and `ImmudbModule` are not registered; the reconcile cron does nothing.
- **Metric names** (GM `getOrCreate*`): `outbox_backlog{outbox}`, `outbox_oldest_unpublished_age_seconds{outbox}`,
  `outbox_publish_latency_seconds{outbox,topic}`, `outbox_published_total{outbox,topic,outcome}` (`ok`, `error`),
  `outbox_relay_leader{outbox}`; `rate_limit_decisions_total{throttler,scope,outcome}` (`allowed`, `blocked`);
  `billing_checkout_without_idempotency_key_total`; `ledger_postings_total{outcome}` (`posted`, `replayed`, `conflict`),
  `ledger_post_duration_seconds`, `ledger_discrepancies_total{kind}` (new rows only), `ledger_verified_tx_id`,
  `ledger_reconciliation_runs_total{status}`, `ledger_reconciliation_last_success_timestamp_seconds`, `ledger_unverified_tx_lag`.
- **Final squash.** Each domain's squashed `0000_init` keeps the hand-edited SQL of the outbox and ledger migrations, in
  their order: CREATE → distribution call → indexes → RLS → grants → policies.
- **System-method lists after this plan.** Identity: B3's plus `outbox.pollUnpublished`, `outbox.markPublished`,
  `outbox.deletePublishedBefore`. Billing: B3's two plus the four `outbox.*` and the ten names on `LedgerSystemRepository`.

## Lanes and merge order

| Lane | Branch        | Tasks                                    | Owns exclusively                                                                                                                                                              |
| ---- | ------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC   | `og/outbox`   | 1 → 2 → 3                                | `libs/outbox/**` (except `outbox-metrics.*`), `libs/config/src/namespaces/outbox.config.*`, `libs/config/src/all-config.*`, `libs/transport/src/kafka/kafka-producer.*`, fake |
| M    | `og/metrics`  | 4, 8                                     | `libs/outbox/src/outbox-metrics.*`, `libs/redis/src/throttler/**`                                                                                                             |
| DI   | `og/identity` | 5                                        | `domains/identity/**`                                                                                                                                                         |
| DB   | `og/billing`  | 6 → 9 → 10 → 11 → 12 → 13 → 15 → 16 → 17 | `domains/billing/**`, `docker/kafka/topics.txt`                                                                                                                               |
| A    | `og/apps`     | 7, 14, 18, 19                            | `apps/**`, `docker-compose.yml`, `docker/{immudb,prometheus}/**`, `scripts/prometheus-rules.spec.ts`, `.env.example`, `docs/**`, package READMEs                              |

Edits outside a lane's files: Tasks 4, 8 in `docs/OBSERVABILITY.md`; Task 4 in `libs/outbox/src/outbox-relay.ts`; Task 8
in `apps/monolith/test/rate-limit.e2e-spec.ts`; Tasks 12, 17 in the root `.env.example` and `docs/CONFIGURATION.md`; Task
18 in `libs/config/src/namespaces/immudb.config.ts`. Lanes merge into `og/integration` (cut from `feat` after B3), which
`feat` takes in one merge after the final review. At most four implementers at once. The controller runs `bun install`
after Task 1 and at the merges of Tasks 5, 6, 7 and 14 (new workspace dependencies).

1. **Wave 1 (outbox core).** OC: Tasks 1, 2.
2. **Wave 2 (parallel).** OC: Task 3. DI: Task 5. DB: Task 6, then 9. M: Task 8.
3. **Wave 3 (parallel).** M: Task 4. A: Task 7. DB: Tasks 10 → 11 → 12 (ledger wave 1). Full gate.
4. **Wave 4 (ledger wave 2).** DB: Task 13; then A: Task 14 in parallel with DB: Tasks 15 → 16 → 17. Full gate.
5. **Wave 5.** A: Task 18, then 19. Full gate, the final review (`code-review high`), one fix round, one scoped re-review.

## Tasks

### Task 1: `@platform/outbox` package, config namespace, `OutboxWriter`, `publishStored` (G-1 and G-2 core)

- **Goal.** A new workspace package holds the parts of the outbox that name no domain: here the `outbox` namespace, the
  table type, the runtime writer and the transport method that sends a stored envelope unchanged. The writer refuses
  to run outside an open transaction, because a row written on its own would defeat the outbox.
- **Files.** Create `libs/outbox/{package.json,tsconfig.json,README.md}` (modeled on `libs/redis`; exports `.`,
  `./testing`, `./package.json`; dependencies `@platform/{common,config,contracts,database,observability,redis,transport}`),
  `libs/outbox/src/{index.ts,outbox.types.ts,outbox.errors.ts,outbox-writer.ts,outbox-writer.spec.ts}`,
  `libs/outbox/src/testing/{index.ts,describe-outbox-table.ts,in-memory-outbox.ts,in-memory-outbox.spec.ts}`,
  `libs/config/src/namespaces/{outbox.config.ts,outbox.config.spec.ts}`. Modify `libs/config/src/{all-config.ts,all-config.spec.ts,index.ts}`,
  `libs/transport/src/kafka/kafka-producer.service.ts` (+ spec), `libs/transport/src/kafka/testing/fake-kafka-producer.ts`,
  root `.env.example`, `docs/CONFIGURATION.md`.
- **Interfaces.** Contract: the `outbox` namespace, `publishStored`, `OutboxTable`, `OutboxFeature`, `OutboxRecord`,
  `OutboxRow`, `OutboxError`, `OutboxWriter` (constructor `(feature, txHost: DrizzleTransactionHost, kafka: KafkaProducer)`),
  `InMemoryOutbox`, `describeOutboxTable`. Each domain declares the table by hand in its schema file (drizzle-kit
  loads schema files without workspace resolution, conventions §4.5); the package only types it.
- **Acceptance tests.**
  - `outbox.config.spec.ts`: the six defaults; rejects batch size 0 and 501, a poll interval under 50, a lock TTL under
    1000 and a maximum backoff below the poll interval. `all-config.spec.ts` lists `outbox`.
  - `outbox-writer.spec.ts` (recording transaction host, `FakeKafkaProducer`): outside a transaction `enqueue` rejects
    with `OUTBOX_NO_TRANSACTION` and sends no SQL; inside one it sends exactly one INSERT with the principal's tenant,
    `envelope.id`, `contract.topic`, the key and the envelope, and its SQL has neither `RETURNING` nor `ON CONFLICT`; a
    payload the contract rejects throws `InvalidEventException` before SQL; a principal without a tenant →
    `OUTBOX_TENANT_REQUIRED`; `options.tenantId` other than the principal's → `OUTBOX_TENANT_MISMATCH`; the nil tenant
    → `OUTBOX_PLATFORM_TENANT`; the envelope equals what `KafkaProducer.createRecord` returns for the same input;
    `record()` works with no transaction and no principal when `tenantId` is given.
  - `kafka-producer.service.spec.ts` (added): `publishStored` sends the key and the envelope unchanged (id,
    `occurredAt`, tenant, actor) with headers `x-event-type` and, when set, `x-correlation-id`; a CLS correlation id is
    ignored; `envelope.type !== topic` or a malformed envelope → `InvalidEventException`, nothing sent; a broker error
    → `ExternalServiceException` `PUBLISH_FAILED`; the fake records the call. `in-memory-outbox.spec.ts`: the fake
    passes the cases Task 2 proves on SQL (poll order, marking, platform insert).
- **Dependencies.** B3 Tasks 5, 7; B2e Task 4. **Lane.** OC. **Review:** no.

### Task 2: Outbox system repository base: poll, mark-published, platform insert, purge (G-3 data access)

- **Goal.** The four system methods of the outbox exist once, as an abstract repository over an `OutboxFeature`, proven
  on a distributed fixture table built from "Outbox table". Polling also returns the backlog statistics for the metrics.
- **Files.** Create `libs/outbox/src/{outbox.system-repository.ts,outbox-system-methods.ts,outbox-sql.spec.ts}`,
  `libs/outbox/test/{outbox-fixture.ts,outbox.system-repository.int-spec.ts}`. Modify `libs/outbox/src/index.ts`.
- **Interfaces.** Contract: `OUTBOX_SYSTEM_METHODS`, `OutboxPoll`, `OutboxSystemRepository` (protected constructor
  `(feature, system: SystemDatabase)`; every call is `system.run(OUTBOX_SYSTEM_METHODS.x, …)`). `markPublished` issues
  one statement per tenant (`tenant_id = $1 AND id = ANY($2) AND published_at IS NULL`) or per row, never a multi-shard
  UPDATE. `pollUnpublished` reads the rows and `count(*)`, `min(created_at)` of the unpublished rows in one call.
- **Acceptance tests.**
  - `outbox-sql.spec.ts` (generated SQL text): the poll has no `FOR UPDATE` and orders by `created_at, id`; every mark
    statement carries `tenant_id =`; the purge filters on `published_at IS NOT NULL AND published_at <`.
  - `outbox.system-repository.int-spec.ts` (`startRlsTestPostgres()`; fixture schema `fx`; tenants A, B, C):
    `pg_dist_partition` shows `fx.outbox` distributed by `tenant_id`, colocated with `app.tenant_colocation`. Runtime
    role as A: inserts its own row; a row for B, for the nil tenant or from a principal without a tenant is rejected;
    SELECT, UPDATE and DELETE raise `42501`. `pollUnpublished(2)` over five rows of three tenants returns the two
    oldest by `(created_at, id)`, `backlog` 5 and the oldest `created_at`; published rows never come back.
    `markPublished` stamps only the given pairs and returns their count; a second call returns 0 and keeps the first
    timestamp; the right id under the wrong tenant changes nothing. `insertAsPlatform` inserts nil-tenant rows that the
    poll returns, returns 0 for the same ids again and throws before SQL for another tenant's record.
    `deletePublishedBefore` removes old published rows on every shard, never an unpublished one. Outside `SystemContext`
    every method rejects with `SYSTEM_CONTEXT_REQUIRED`.
- **Dependencies.** Task 1; B3 Tasks 2, 7. **Lane.** OC. **Review:** no.

### Task 3: `OutboxRelay`: leadership, poll loop, at-least-once publish (G-3)

- **Goal.** One relay per outbox runs in every process that owns the domain, and only the holder of the Redis lock
  `outbox-relay:<name>` publishes. Delivery is at-least-once: a row is marked only after the broker acknowledged it,
  every failure ends in a resend, and no Postgres transaction is ever held across a publish.
- **Files.** Create `libs/outbox/src/{outbox-relay.ts,outbox-relay.spec.ts,outbox.module.ts,outbox.module.spec.ts}`,
  `libs/outbox/test/outbox-relay.int-spec.ts`. Modify `libs/outbox/src/index.ts`, `libs/outbox/README.md`.
- **Interfaces.** Contract: `OutboxRelay`, `OutboxTickResult`, `OutboxModule.forFeature`. Binding behaviour (SH §7.4):
  1. **Term.** `DistributedLockService.using('outbox-relay:<name>', lockTtlMs, term)`. Not acquired (`held` or `error`)
     → `'not-leader'`, try again after `pollIntervalMs` with jitter. The lock's auto-extension is the spec's "TTL
     renewed every poll". When the lock's signal aborts, the relay stops before the next publish and returns `'lost'`.
  2. **Tick.** Inside `SystemContext.run('outbox.relay', …)`: `pollUnpublished(batchSize)`; publish the rows one by one
     in poll order with `publishStored(topic, envelope, key)`; then `markPublished` for the rows whose publish
     resolved. A full batch polls again at once; an empty poll waits `pollIntervalMs`.
  3. **Failure.** The first failed publish ends the batch: earlier rows are marked, the failed row and the later ones
     stay, the wait doubles from `pollIntervalMs` up to `maxBackoffMs` and resets after a clean tick. A failed
     `markPublished` or poll is logged and counted; those rows go out again on the next tick.
  4. **Purge.** Once per hour of leadership: `deletePublishedBefore(now − retentionHours)`.
  5. **Lifecycle.** Not started when `relayEnabled` is false or the process has no system pool (one warning). Shutdown
     aborts the term and waits for the in-flight publish, at most `lockTtlMs`.
- **Acceptance tests.**
  - `outbox-relay.spec.ts` (`InMemoryOutbox`, `FakeKafkaProducer`, a fake lock with a controllable signal, fake
    timers): publishes follow row order; a row is marked only after its publish resolved; with a failure at row k of n,
    rows before k are marked, k..n are not, `failed` is true, the next tick starts at k, and the delay doubles to the
    cap and then resets; a rejecting `markPublished` resolves the tick and the same envelope ids go out again; a signal
    aborted mid-batch stops further publishes, still marks what was acknowledged, and `runTerm` returns `'lost'`; lock
    `held` → `'not-leader'` and the repository is never called; inside every repository call `SystemContext.isActive()`
    is true with reason `outbox.relay`; no repository call overlaps a publish; `relayEnabled=false` never asks for the
    lock; a throwing poll does not end the term; shutdown resolves within `lockTtlMs`; the purge runs once per hour of
    fake time. `outbox.module.spec.ts`: two `forFeature` calls give two relays, writers and repositories.
  - `outbox-relay.int-spec.ts` (`startRlsTestPostgres()`, real Redis, `FakeKafkaProducer`; two relay instances on one
    feature; 200 rows over five tenants written by the runtime role): every row is published at least once and ends
    with `published_at` set; a shared counter shows at most one instance inside a term at any time; stopping the leader
    mid-run lets the other finish within `lockTtlMs + 2 × pollIntervalMs`; the set of published envelope ids equals the
    set of row ids (duplicates allowed, none missing).
- **Dependencies.** Tasks 1, 2. **Lane.** OC. **Review:** yes.

### Task 4: Outbox backlog and latency metrics (G-9)

- **Goal.** The leader exports backlog, age of the oldest unpublished row, commit-to-publish latency and publish
  outcomes per outbox. A process that is not the leader exports no backlog, so a dashboard never sums stale values.
- **Files.** Create `libs/outbox/src/{outbox-metrics.ts,outbox-metrics.spec.ts}`. Modify `libs/outbox/src/outbox-relay.ts`,
  `libs/outbox/README.md`, `docs/OBSERVABILITY.md`.
- **Interfaces.** The five `outbox_*` series of "Metric names", created with GM's `getOrCreate*`. Latency is publish
  time minus `created_at`, observed once per acknowledged row. When a term ends, `outbox_relay_leader` is 0 and the
  backlog and age series of that label are removed.
- **Acceptance tests.** `outbox-metrics.spec.ts` (prom-client registry): after a tick with backlog 7 whose oldest row is
  30 s old the gauges read 7 and 30 (± 1); an empty outbox reads 0 and 0; one latency observation per published row in
  `{outbox,topic}`; `outcome="error"` increments for the failed row only; the leader gauge is 1 inside a term and 0
  after it, and backlog and age are then absent from the scrape; two features keep separate label values.
- **Dependencies.** Task 3; GM Task 7. **Lane.** M. **Review:** no.

### Task 5: Identity outbox: table, RLS, system repository and the registration event (G-1, G-2 identity)

- **Goal.** `identity.outbox` exists exactly as "Outbox table" says, in one migration that also distributes it and
  locks it down, with identity's writer, feature and thin system repository. `identity.user-registered.v1` is enqueued
  in the registration unit of work and `UserRegisteredRelay` is deleted: no registration commits without its event.
- **Files.** Create `domains/identity/src/infrastructure/persistence/migrations/NNNN_outbox.sql` (+ journal, snapshot),
  `…/persistence/{identity-outbox.ts,drizzle-outbox.system-repository.ts,identity.outbox.rls.int-spec.ts}`,
  `domains/identity/test/register-outbox.int-spec.ts`. Delete `application/event-handlers/user-registered.relay.ts`
  (+ spec). Modify `…/persistence/identity.schema.ts` (table `outbox`, comment `// citus: tenant`; its spec calls
  `describeOutboxTable(outbox, 'identity')`), `…/persistence/identity.system-methods.ts` (+ spec),
  `identity.migrations.spec.ts`, `identity-core.module.ts` (`OutboxModule.forFeature`),
  `application/commands/register-user/register-user.handler.ts` (+ spec),
  `domains/identity/contracts/src/events/identity.events.ts` (`{ tenantScoped: true }`), `src/index.ts`,
  `src/testing/in-memory-identity.ts` (binds `InMemoryOutbox`), `package.json`, `README.md`.
- **Interfaces.** Contract: `IdentityOutbox`, `IDENTITY_OUTBOX`; `IdentityOutboxSystemRepository extends OutboxSystemRepository`;
  the pinned list gains the three relay methods (identity writes no platform rows). The record: key = user id, envelope
  id = the domain event id, `occurredAt` = the event's, tenant = the personal tenant of B3 Task 12's registration
  principal, actor = the user, payload as the relay built it. In-process handlers of the domain event still run after
  commit. Any other `KafkaProducer.publish` call left in `domains/identity/src` gets the same treatment.
- **Acceptance tests.**
  - `identity.outbox.rls.int-spec.ts` (`startRlsTestPostgres()`, the real migration set run as `app_owner`):
    `pg_dist_partition` has `identity.outbox` by `tenant_id`, colocated with `app.tenant_colocation`; `relrowsecurity`
    and `relforcerowsecurity` are true; `information_schema.role_table_grants` shows exactly INSERT for `app_runtime`
    and SELECT, INSERT, UPDATE, DELETE for `app_system`; `pg_policies` shows exactly `outbox_insert`; a principal of
    tenant A inserts its own row, and a row for tenant B or from a principal without a tenant is rejected; runtime
    SELECT, UPDATE and DELETE raise `42501`; the system repository polls and marks the row.
    `identity.system-methods.spec.ts` pins the longer list and the file set; `bun run db:check` is clean.
  - `register-user.handler.spec.ts`: one record with the stated fields, enqueued before the unit of work commits; no
    call to `KafkaProducer.publish`; a failing enqueue rejects the registration.
  - `register-outbox.int-spec.ts`: a successful registration leaves exactly one unpublished row under the new tenant; a
    failure injected into the last repository call of the unit of work leaves neither user nor row; one tick of a real
    `OutboxRelay` with `FakeKafkaProducer` publishes an envelope that parses with `USER_REGISTERED_EVENT` and marks the
    row. `rg -n "kafka\.publish" domains/identity/src` returns nothing.
- **Dependencies.** Task 2; B3 Tasks 10, 11, 12. **Lane.** DI. **Review:** no.

### Task 6: Billing outbox: table, RLS, system repository and `billing.payment-succeeded.v1` (G-1, G-2 billing)

- **Goal.** The same as Task 5 for `billing.outbox` (the first billing migration after B3's), plus
  `outbox.insertAsPlatform`, the only way a row with `PLATFORM_TENANT_ID` enters the table. The webhook unit of work
  that completes the payment also enqueues `billing.payment-succeeded.v1`, and `PaymentSucceededRelay` is deleted.
- **Files.** Create `domains/billing/src/infrastructure/persistence/migrations/NNNN_outbox.sql` (+ journal, snapshot),
  `…/persistence/{billing-outbox.ts,drizzle-outbox.system-repository.ts,billing.outbox.rls.int-spec.ts}`,
  `domains/billing/test/webhook-outbox.int-spec.ts`. Delete `application/relays/payment-succeeded.relay.ts` (+ spec).
  Modify `…/persistence/billing.schema.ts` (+ spec), `…/persistence/billing.system-methods.ts` (+ spec),
  `billing.migrations.spec.ts`, `billing-core.module.ts`,
  `application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.ts` (+ spec),
  `application/mappers/payment.mapper.ts` (takes `toPaymentSucceededPayload`), `src/index.ts`, `src/testing/index.ts`,
  `package.json`, `README.md` ("Consistency").
- **Interfaces.** Contract: `BillingOutbox`, `BILLING_OUTBOX`; `BillingOutboxSystemRepository`; the pinned list gains
  all four `outbox.*` names. The record: key = user id, envelope id = the `PaymentSucceededEvent` id, `occurredAt` =
  `paidAt`, tenant and actor = the signed owner (the unit of work's principal).
- **Acceptance tests.**
  - `billing.outbox.rls.int-spec.ts`: every case of Task 5's RLS spec for `billing.outbox`; in addition a runtime
    insert with the nil tenant is rejected, and a row written by `insertAsPlatform` is invisible to and unchangeable by
    every runtime principal, elevated or not, and is returned by the poll. `billing.system-methods.spec.ts` pins the
    list and the file set; `bun run db:check` is clean.
  - Handler spec: a paid session enqueues one such record after `markProcessed` and `save` and before commit; a
    duplicate delivery, an unpaid completion, a failed and an expired session enqueue nothing; a failing enqueue
    rejects and leaves no receipt and no transition.
  - `webhook-outbox.int-spec.ts` (`startRlsTestPostgres()`): a signed `checkout.session.completed` for tenant A leaves
    the payment succeeded, the receipt and one outbox row with A's `tenant_id`; with that row's id pre-seeded through
    the system pool the delivery fails and leaves the payment pending and no receipt; a replay adds no row; a relay
    tick publishes an envelope that parses with `PAYMENT_SUCCEEDED_EVENT`.
- **Dependencies.** Task 2; B3 Tasks 14, 15, 16. **Lane.** DB. **Review:** no.

### Task 7: Relays in the apps and the outbox e2e (G-3 wiring)

- **Goal.** Monolith, identity-service and billing-service load the `outbox` namespace and run their relays; the
  gateway has none. An e2e spec proves the path request → outbox → relay → Kafka → consumer in the monolith.
- **Files.** Create `apps/monolith/test/outbox.e2e-spec.ts`. Modify `apps/{monolith,identity-service,billing-service}/test/{env-example.spec.ts,app.e2e-spec.ts}`,
  their `test/support/**` (in-memory outbox binding) and `package.json`, `apps/*/.env.example`, `apps/gateway/test/app.e2e-spec.ts`.
- **Interfaces.** None new. The e2e apps bind `InMemoryOutbox` and drive the relay with `tick()`.
- **Acceptance tests.** `outbox.e2e-spec.ts`: a REST registration puts exactly one `identity.user-registered.v1` on the
  fake producer, with the tenant in the envelope, and only after a relay tick; with the producer failing, registration
  still answers 201 and a later tick delivers the event; a signed paid webhook yields one `billing.payment-succeeded.v1`
  and a replayed webhook no second one; the welcome and receipt notifications still arrive. Service e2e: the relay
  resolves and never asks for the lock when disabled. Gateway e2e: it does not resolve. Env specs list `outbox`.
- **Dependencies.** Tasks 3, 5, 6. **Lane.** A. **Review:** no.

### Task 8: Rate-limit decision metrics (G-10)

- **Goal.** Every rate-limit decision is counted once, by throttler, policy scope and outcome, at the two places phase
  C routes all decisions through. Labels stay bounded: no tracker, key, IP, user or tenant.
- **Files.** Create `libs/redis/src/throttler/{rate-limit-metrics.ts,rate-limit-metrics.spec.ts}`. Modify
  `libs/redis/src/throttler/{rate-limit-guard.base.ts,rate-limit-charger.ts}` (+ specs), `libs/redis/src/index.ts`,
  `apps/monolith/test/rate-limit.e2e-spec.ts`, `docs/OBSERVABILITY.md`.
- **Interfaces.** `export const RATE_LIMIT_DECISIONS_TOTAL = 'rate_limit_decisions_total'`;
  `export function recordRateLimitDecision(decision: RateLimitDecision): void` (outcome `blocked` when
  `decision.blocked`, else `allowed`). Called as the first statement of `RateLimitGuardBase.recordDecision` and once in
  `RateLimitCharger.charge`; a decision that passes through both is counted once.
- **Acceptance tests.** `rate-limit-metrics.spec.ts`: allowed and blocked decisions increment the matching series; label
  names are exactly `throttler`, `scope`, `outcome`. Guard base spec: a decision is counted even when `recordDecision`
  returns early. Charger spec: one increment per charge whatever the weight; a fail-open charge counts as `allowed` and
  leaves `rate_limit_fail_open_total` as C5 defined it. e2e: after three allowed requests and one blocked request on a
  policy route the scrape shows 3 and 1 for that throttler and scope; a cost-charged GraphQL operation adds exactly one.
- **Dependencies.** C4 and C9 (the charger half cannot land before C9); GM Task 7. **Lane.** M. **Review:** no.

### Task 9: Checkout requests without an Idempotency-Key (S-4b)

- **Goal.** Checkout requests that send no `Idempotency-Key` are counted and logged at debug, so the team can see how
  many clients skip it. The header stays optional.
- **Files.** Modify `application/commands/create-checkout-session/create-checkout-session.handler.ts` (+ spec),
  `billing-core.module.ts` (counter provider), `docs/OBSERVABILITY.md`, `docs/API.md` ("key lifetime = payment lifetime").
- **Interfaces.** Counter `billing_checkout_without_idempotency_key_total`, no labels.
- **Acceptance tests.** Handler spec: a command without a key increments the counter once and logs one debug line
  carrying only `userId` and `tenantId`; a command with a key does neither; both return what they return today.
- **Dependencies.** B2e Task 2. **Lane.** DB. **Review:** no.

### Task 10: Postgres ledger tables with distribution and RLS (L-10, schema)

- **Goal.** One billing migration creates the five tables of "Ledger tables": three distributed by `tenant_id` inline,
  two coordinator-local, all with forced RLS, explicit grants and two policies per tenant table. Entry refs and
  discrepancies are append-only for both application roles.
- **Files.** Create `…/persistence/migrations/NNNN_ledger_tables.sql` (+ journal, snapshot),
  `…/persistence/billing.ledger.rls.int-spec.ts`. Modify `…/persistence/billing.schema.ts` (five tables, each with its
  `// citus: tenant` or `// citus: local` comment; `bigint({ mode: 'bigint' })` for `immudb_tx_id` and `tx_id`),
  `billing.migrations.spec.ts`, `domains/billing/README.md`.
- **Interfaces.** The "Ledger tables" table is the contract (columns, keys, grants, policy expressions).
- **Acceptance tests.** `billing.ledger.rls.int-spec.ts` (`startRlsTestPostgres()`; tenants A and B, member a1, platform
  rows seeded through the system pool):
  - `pg_dist_partition` lists the three tenant tables by `tenant_id`, colocated with `app.tenant_colocation`, and
    neither local table; all five have forced RLS and no foreign key; grants and policy names are exactly the contract's.
  - Each tenant table, both paths: a1 inserts an own-tenant row without elevation; a row for B or the nil tenant is
    rejected; SELECT returns nothing without elevation, A's rows with it, never B's or the platform's; UPDATE and
    DELETE raise `42501` for the runtime role, elevated or not, and for `app_system` on refs and discrepancies.
  - Local tables: runtime SELECT and INSERT raise `42501`; the system role reads and writes them.
  - Probe, as non-elevated a1 inserting the same `ledger_entry_refs` key twice: `INSERT … ON CONFLICT DO NOTHING` (no
    target, no `RETURNING`) reports 1 row, then 0. If Citus or RLS refuses that form, the case pins a plain INSERT
    failing with `23505` instead, and its title says which form Task 11 must use. With no context nothing is readable.
- **Dependencies.** Task 6 (billing migration order); B3 Task 14. **Lane.** DB. **Review:** no.

### Task 11: Ledger repositories and system methods 9-11 (L-10, repositories)

- **Goal.** The runtime receipts repository and the ledger system repository exist with in-memory twins, and billing's
  pinned system-method list carries spec §9 items 9-11 plus `ledgerAccounts.recordPlatformAccounts`. Discrepancy ids
  are deterministic, so overlapping reconciliation windows cannot duplicate a finding.
- **Files.** Create `domain/ledger/{ledger-discrepancy.ts,ledger-discrepancy.spec.ts}`,
  `application/repositories/{ledger-receipts.repository.ts,ledger.system-repository.ts}`,
  `infrastructure/persistence/{drizzle-ledger-receipts.repository.ts,drizzle-ledger.system-repository.ts,billing.ledger-repositories.rls.int-spec.ts}`,
  `src/testing/in-memory-ledger-store.ts`. Modify `…/persistence/billing.system-methods.ts` (+ spec),
  `billing-core.module.ts`, `src/index.ts`, `src/testing/index.ts`.
- **Interfaces.** Contract: `LedgerDiscrepancyKind`, `LedgerDetector`, `LedgerDiscrepancyInput`, `ledgerDiscrepancyId`,
  `LedgerEntryRef`, `LedgerAccountRef`, `LedgerCursor`, `PaidPaymentRow`, `LedgerRunCounts`, `LedgerReceiptsRepository`,
  `LedgerSystemRepository`. Lists are keyset pages by `(tenant_id, id)` over half-open windows: payments by `paid_at`
  with status succeeded, refunded, partially_refunded or disputed; refs by `posted_at`.
- **Acceptance tests.**
  - `ledger-discrepancy.spec.ts`: a pinned golden id; the id ignores key order in `expected` and `actual` and changes
    when the kind, the source key or either object changes.
  - `billing.system-methods.spec.ts`: the list and file set of "System-method lists after this plan".
  - `billing.ledger-repositories.rls.int-spec.ts`. Runtime, as non-elevated a1: `recordEntryRef` returns true, then
    false; a ref for tenant B is rejected; `recordAccounts` is idempotent and throws before SQL for a platform-owned
    row; `appendDiscrepancy` returns true, then false for the identical finding. System: both lists return every
    tenant's rows, the platform's included, in `(tenant_id, id)` order without gap or repeat over three pages, within
    `[from, to)`; `appendDiscrepancies` returns the count of new rows, 0 for the same batch again;
    `enqueueMissingPostings` inserts into `billing.outbox` for two tenants and the platform, idempotent by id, and the
    outbox poll returns the rows; `recordEntryRefs` is idempotent; `recordPlatformAccounts` throws before SQL for a
    non-platform row; `advanceTrustedState(db, null, s1)` is true once, then false; `(db, s1, s2)` is true; a stale
    `(db, s1, s3)` is false and leaves s2; `to.txId < from.txId` throws before SQL; `finishRun` on a finished run
    changes nothing; every method rejects outside `SystemContext`; no UPDATE or DELETE exists for refs or discrepancies.
- **Dependencies.** Task 10. **Lane.** DB. **Review:** no.

### Task 12: Ledger-posting contract, topic and webhook coverage (L-11)

- **Goal.** The webhook handles the money events beyond checkout, moves the payment to its new statuses (S-6) and,
  when the ledger is enabled, writes a `billing.ledger-posting.v1` outbox row in the unit of work of the receipt. Stripe
  lookups for the owner happen before that unit of work opens; platform-level events (`payout.*`) take the system path.
- **Files.** Create `application/ledger/{stripe-owner-resolver.ts,stripe-owner-resolver.spec.ts,ledger-posting-request.ts,ledger-posting-request.spec.ts}`,
  `infrastructure/ledger/{ledger.config.ts,ledger.config.spec.ts}` (the three variables of the contract, also in the root
  `.env.example` and `docs/CONFIGURATION.md`), `domains/billing/test/{webhook-ledger.int-spec.ts,webhook-platform.int-spec.ts}`. Modify
  `domains/billing/contracts/src/events/billing.events.ts` (+ spec), `docker/kafka/topics.txt` (topic and `.dlq`,
  settings as `billing.payment-succeeded.v1`), `application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.ts`
  (+ spec), `domain/payment.aggregate.ts` (+ spec: `refund`, `dispute`, `reinstate`),
  `infrastructure/stripe/stripe.service.ts` (+ spec: `retrievePaymentIntent`), `domains/billing/README.md` (the Stripe
  event types to enable).
- **Interfaces.** Contract: `LEDGER_POSTING_REQUESTED_EVENT`, the `ledger` namespace;
  `StripeOwnerResolver#resolve(object: unknown): Promise<StripeOwner & { readonly paymentId: string | null; readonly unresolved: boolean }>`
  (`object` = an event's `data.object` or a balance transaction's expanded source);
  `ledgerPostingRecord(outbox, event, owner, objectType, objectId): OutboxRecord` ("Envelope ids"). A tenant row is
  written by `BillingOutbox.enqueue` as the owner, key = tenant id, actor = user id. An unresolved owner is recorded as
  a platform receipt with a warning and no posting row (R4 heals it). A resolved owner whose payment id names no payment
  of that tenant still gets its row, with `paymentId: null`. Platform events run in
  `SystemContext.run('billing.platform-webhook', …)`: `outbox.insertAsPlatform([record])` first (tenant and key = the nil
  UUID, user and actor null), then `stripeEvents.markProcessedAsPlatform`; the system pool has no transaction across two
  methods, so both are idempotent and a crash between them is healed by Stripe's redelivery. Binding table:

| Stripe event                                                                   | Owner from                              | Payment transition                                                      | Posting row       |
| ------------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------- | ----------------- |
| `checkout.session.completed`, `async_payment_succeeded` (paid)                 | session metadata (B3 Task 16)           | → `succeeded`, as today                                                 | none              |
| `charge.succeeded`                                                             | charge metadata, else its PaymentIntent | none                                                                    | `charge`, `ch_…`  |
| `charge.refunded`                                                              | same                                    | → `refunded` when `amount_refunded = amount`, else `partially_refunded` | none              |
| `refund.created` and `refund.updated` with status `succeeded`; `refund.failed` | the refund's PaymentIntent              | none                                                                    | `refund`, `re_…`  |
| `charge.dispute.funds_withdrawn`                                               | the dispute's PaymentIntent             | → `disputed`                                                            | `dispute`, `du_…` |
| `charge.dispute.funds_reinstated`                                              | same                                    | `disputed` → `succeeded`                                                | `dispute`, `du_…` |
| `payout.paid`, `payout.failed`                                                 | none: the platform                      | none                                                                    | `payout`, `po_…`  |

- **Acceptance tests.**
  - Contract spec: the payload accepts the nil tenant and a null user and payment and rejects an unknown `objectType`;
    the contract is tenant-scoped. `check-kafka-topics.mjs` passes.
  - `stripe-owner-resolver.spec.ts`: a charge with metadata costs no Stripe call; a charge without it, a refund and a
    dispute cost exactly one PaymentIntent GET each; a missing PaymentIntent, a non-UUID id or the nil tenant in the
    metadata gives `PLATFORM_OWNER` with `unresolved: true`.
  - `payment.aggregate.spec.ts`: each new transition, its refusal from `pending`, and a repeat that changes nothing.
  - Handler spec, one case per table row: the stated transition and exactly the stated record (payload fields,
    deterministic envelope id, key, actor) in the unit of work of the receipt; a duplicate event does nothing;
    `refund.updated` with status `pending` writes no row; an unresolved owner calls `markProcessedAsPlatform` and
    touches no payment; with `LEDGER_ENABLED=false` transitions happen and no posting row is written; no Stripe call
    happens while the unit of work is open. `payout.paid`: the stated record and call order; a redelivery after a
    simulated crash between the two calls adds no second row and records the receipt, and a third delivery answers
    `duplicate: true`; `BillingOutbox.enqueue` is never called; a spy on `SystemDatabase.run` sees only those two methods.
  - `webhook-ledger.int-spec.ts`: `charge.succeeded` for tenant A commits the receipt and the posting row together (a
    forced outbox failure leaves neither); metadata naming tenant A with a payment id of tenant B changes no payment of
    B; a replay leaves one row. `webhook-platform.int-spec.ts`: no runtime principal can read the payout row; a relay
    tick publishes it with the nil tenant in the envelope.
- **Dependencies.** Tasks 6, 11; B3 Task 16; W0 L-7, L-8a. **Lane.** DB. **Review:** no.

### Task 13: `LedgerService`, `PostLedgerEntryCommand` and `LedgerPostingConsumer` (L-12)

- **Goal.** A billing consumer turns each `billing.ledger-posting.v1` message into ledger entries, one per Stripe
  balance transaction, as the envelope's principal or in `SystemContext` for platform and user-less messages.
  At-least-once delivery plus deterministic entry ids give an exactly-once effect; `LedgerService` enforces the tenant rule.
- **Files.** Create `infrastructure/ledger/{billing-ledger.module.ts,ledger-metrics.ts}`,
  `application/ledger/{ledger.service.ts,ledger.service.spec.ts}`,
  `application/commands/post-ledger-entry/{post-ledger-entry.command.ts,post-ledger-entry.handler.ts,post-ledger-entry.handler.spec.ts}`,
  `application/commands/process-ledger-posting/` (the same three files),
  `presentation/messaging/{ledger-posting.consumer.ts,ledger-posting.consumer.spec.ts}`, `billing-messaging.module.ts`,
  `domains/billing/test/ledger-posting.int-spec.ts`. Modify `infrastructure/stripe/stripe.service.ts` (+ spec),
  `billing.constants.ts` (`LEDGER_TENANT_MISMATCH`, `LEDGER_DISABLED`), `domain/billing.errors.ts`, `src/index.ts`.
- **Interfaces.** Contract: `LedgerService`, `PostLedgerEntryCommand`, `ProcessLedgerPostingCommand`.
  `BillingLedgerModule` binds `LedgerPort` to `ImmudbLedgerAdapter` when enabled and to a
  ledger that throws `LEDGER_DISABLED` otherwise; `BillingMessagingModule` registers the consumer.
  `StripeService#ledgerSource(objectType, objectId): Promise<{ readonly transactions: readonly PostingBalanceTransaction[]; readonly pending: boolean; readonly presentment: { readonly amount: bigint; readonly currency: string } | null }>`
  (charge and payout: the object's balance transaction; refund: its balance transaction, and the failure one after
  `refund.failed`; dispute: every entry of `balance_transactions`; `pending` when Stripe has none yet). Flow: the
  consumer checks the envelope against the payload → principal, or `SystemContext.run('billing.ledger-posting', …)` →
  `ProcessLedgerPostingCommand` → `ledgerSource` (no transaction open) → per transaction `draftFromBalanceTransaction`
  → `PostLedgerEntryCommand` → `LedgerService.post` → receipts. Receipts of a principal go through
  `LedgerReceiptsRepository`; the platform-owned account rows of a tenant posting go through `recordPlatformAccounts`
  inside a nested `SystemContext.run('billing.ledger-platform-accounts', …)`; in `SystemContext` every receipt goes
  through `LedgerSystemRepository`. Outcomes:

| Condition                                                                                                               | Result                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `posted`                                                                                                                | ref with the tx id; account rows; `ledger_postings_total{outcome="posted"}`; acknowledge |
| `replayed`                                                                                                              | ref with `immudbTxId: null` (the idempotent insert keeps an existing ref); acknowledge   |
| `conflict`                                                                                                              | one `post_conflict` discrepancy carrying both hashes; counted; acknowledge               |
| `pending` after three attempts in the handler (1 s, 2 s, 4 s)                                                           | one `fee_unavailable` discrepancy; acknowledge (R4 posts it later)                       |
| immudb `unavailable`; Stripe 5xx, 429 or network error; a Postgres connection or timeout error, also after a post       | `KafkaRetriableException`: redelivered, never dead-lettered                              |
| envelope tenant ≠ payload tenant, envelope actor ≠ payload user, tenant mismatch, unbalanced draft, Stripe 404, `42501` | thrown as is: `billing.ledger-posting.v1.dlq`, no discrepancy                            |

- **Acceptance tests.**
  - `ledger.service.spec.ts`: principal A with a draft of A posts; with a draft of B or of the platform →
    `LEDGER_TENANT_MISMATCH` and the port is never called; `SystemContext` posts platform and tenant drafts; no
    principal and no `SystemContext` → refused; a principal nested inside `SystemContext` is judged as a principal;
    `getEntry` and `balances` use the context's tenant and take none from the caller; disabled → `LEDGER_DISABLED`.
  - `post-ledger-entry.handler.spec.ts` (`InMemoryLedger`, in-memory stores): `posted` writes one ref with the tx id,
    the tenant's account rows through the runtime port and the platform's through the nested system call; the same
    draft again returns `replayed` and adds nothing; the same source key with another amount appends one
    `post_conflict` and changes no ref; a ref write that fails after the post rejects, and the rerun returns `replayed`
    and writes the ref; in `SystemContext` the runtime port is never called.
  - `process-ledger-posting.handler.spec.ts`: a dispute with two balance transactions yields two entries; a charge
    yields a draft of the payload's tenant with the charge's presentment; a payout yields a platform draft; `pending`
    three times appends `fee_unavailable` once and resolves; a `null` draft posts nothing; no unit of work is open
    during `ledgerSource`.
  - `ledger-posting.consumer.spec.ts`: actor and tenant in the envelope → the command runs under that principal; the
    nil tenant or a null actor → `SystemContext` with reason `billing.ledger-posting`; each mismatch of the last table
    row is thrown without dispatching the command; immudb `unavailable` → `KafkaRetriableException`; the same envelope
    delivered twice → the second run is all `replayed`.
  - `ledger-posting.int-spec.ts` (`startRlsTestPostgres()`, immudb Testcontainer, `ImmudbLedgerAdapter`, fake Stripe):
    one charge message for tenant A processed twice concurrently and once more later leaves exactly one entry with
    balanced postings in immudb, one ref under A whose tx id is that entry's or null, and the platform account rows; a
    message whose payload names tenant B inside A's envelope posts nothing; a payout message posts on the platform
    tenant and its Postgres rows are readable by the system pool only.
- **Dependencies.** Tasks 11, 12; W0 L-8b, L-9; B2e Task 4; GM Task 7. **Lane.** DB. **Review:** yes.

### Task 14: Ledger wiring in monolith and billing-service (L-12 wiring)

- **Goal.** With `LEDGER_ENABLED=true` the monolith and billing-service load immudb, register the consumer (the first
  Kafka consumer of billing-service), report immudb in readiness and migrate the ledger from the migrate step; with the
  default `false` they boot without immudb. The gateway gets nothing.
- **Files.** Create `apps/billing-service/src/billing-service.constants.ts` (`BILLING_CONSUMER_GROUP = 'billing-service'`).
  Modify `apps/{monolith,billing-service}/src/{app.module.ts,main.ts,migrate.ts}`, their `package.json` (`@platform/immudb`),
  `test/{app.e2e-spec.ts,env-example.spec.ts}` and `.env.example`, `docker-compose.yml` (`x-env-immudb`,
  `LEDGER_ENABLED`, `depends_on: immudb-init` for both apps), `apps/billing-service/README.md`.
- **Interfaces.** When `ledgerConfig.parse().enabled`: `ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] })`,
  `BillingMessagingModule`, `ImmudbHealthIndicator` in `healthContributors`, `connectKafkaConsumer(app, { groupId: BILLING_CONSUMER_GROUP })`
  in billing-service's `main.ts`, `runImmudbMigrationsCli([billingLedgerMigrations])` in `migrate.ts`. Otherwise none.
- **Acceptance tests.** Both apps' `app.e2e-spec.ts`: with the default env the app boots with no immudb client,
  `/health/ready` has no `immudb` key and no handler is registered for the topic; with `LEDGER_ENABLED=true` and
  `RecordingImmudbClient`, readiness reports `immudb` and the handler is registered; billing-service connects a Kafka
  consumer with group `billing-service` only then. Gateway e2e: neither `ImmudbClient` nor `LedgerPostingConsumer`
  resolves. Both `env-example.spec.ts` list `ledger` and `immudb`; `scripts/docker/validate-compose.sh` passes.
- **Dependencies.** Task 13; W0 L-6. **Lane.** A. **Review:** no.

### Task 15: Reconciliation run, R1-R3 and the hourly cron (L-13, part 1)

- **Goal.** An hourly system job compares the ledger with itself (R1, R2) and with billing's payments (R3) over an
  overlapping window and appends what it finds, never correcting anything. A rerun adds no row; a failing check hides none.
- **Files.** Create `application/commands/reconcile-ledger/{reconcile-ledger.command.ts,reconcile-ledger.handler.ts,reconcile-ledger.handler.spec.ts}`,
  `application/commands/reconcile-ledger/checks/{r1-invariant.ts,r2-mutation.ts,r3-payments.ts}` (+ one spec each),
  `infrastructure/scheduling/{reconcile-ledger.cron.ts,reconcile-ledger.cron.spec.ts}`,
  `domains/billing/test/reconcile-ledger.int-spec.ts`. Modify `billing.constants.ts` (`RECONCILE_LEDGER_LOCK`, its TTL,
  `LEDGER_RECONCILE_GRACE_MS = 900_000`), `infrastructure/ledger/ledger-metrics.ts`, `billing-core.module.ts`.
- **Interfaces.** Contract: `ReconcileLedgerCommand`, `ReconciliationCheck`, `LedgerRunCounts`. Binding behaviour:
  - **Window.** `to = now − LEDGER_RECONCILE_GRACE_MS`, `from = to − reconcileLookbackHours`; an explicit window wins.
  - **Run.** `startRun` → every registered check in order (R1, R2, R3; Tasks 16 and 17 register R4 and R5) →
    `appendDiscrepancies` per check → `finishRun`. A throwing check marks the run `failed` after the others ran; rows
    already appended stay. `found` counts findings, `appended` new rows; the metrics count new rows only.
  - **R1.** `findUnbalanced(window)` → `unbalanced_entry` under the entry's tenant; `totalsByCurrency()` with debit ≠
    credit → `unbalanced_currency` under the platform tenant.
  - **R2.** `findMutations()` → `ledger_row_mutated` under the platform tenant, source key `<table>:<id>`.
  - **R3.** Pages of 500 from `listSucceededPayments` over `[from − 24 h, to)` and `listEntryRefs` over the window,
    joined in memory by tenant and payment id. A paid payment inside the window without a `charge` ref →
    `payment_without_entry`; a `charge` ref with no payment id, or with one that is not listed →
    `entry_without_payment`; per pair, from `LedgerPort.getEntry`: presentment amount or currency ≠ the payment's →
    `amount_mismatch`, entry tenant ≠ ref tenant → `tenant_mismatch`; a status that disagrees with the refs (`refunded`
    or `partially_refunded` without a net refund ref, `disputed` without an open dispute ref, `succeeded` with
    either) → `status_mismatch`.
  - **Cron.** `@Cron(EVERY_HOUR, { name: 'billing.reconcile-ledger', timeZone: 'UTC', waitForCompletion: true })` with
    `@WithLock`, running the command inside `SystemContext.run('billing.reconcile-ledger', …)`; it does nothing when
    the ledger is disabled and never throws into the scheduler.
- **Acceptance tests.**
  - One spec per check (`InMemoryLedger`, in-memory stores), one fixture per kind: the kind appears for its fixture and
    nothing appears for the clean fixture. R1: an entry balanced per currency in two currencies is clean; one that is
    off by 1 minor unit in one currency is not. R3: all five kinds; a payment and its ref on different pages still
    pair; a payment paid 5 minutes ago is not reported.
  - `reconcile-ledger.handler.spec.ts`: a clean ledger gives a `succeeded` run with zero counts; the same dirty window
    twice gives equal `found`, and `appended` 0 the second time; with R2 throwing, R3 still runs, the run is `failed`
    and R1's rows stay; every finding carries its detector and the run id; outside `SystemContext` the command rejects
    with `SYSTEM_CONTEXT_REQUIRED`; `ledger_reconciliation_runs_total{status}`, the last-success timestamp and
    `ledger_discrepancies_total{kind}` move as stated.
  - `reconcile-ledger.cron.spec.ts`: disabled → no command; enabled → one command inside `SystemContext`; lock not
    acquired → skipped; a rejecting command is logged and swallowed.
  - `reconcile-ledger.int-spec.ts` (Citus and immudb; data seeded through the real posting path for two tenants and
    the platform): a clean run appends nothing and finishes a `ledger_reconciliation_runs` row with its counts; after
    seeding a paid payment without an entry and a ref under the wrong tenant, the expected rows exist under the right
    `tenant_id`, readable by that tenant's elevated principal only.
- **Dependencies.** Task 13. **Lane.** DB. **Review:** yes.

### Task 16: Reconciliation R4: Stripe balance transactions against the ledger (L-13, part 2)

- **Goal.** R4 lists Stripe's balance transactions for the window and checks that each has its ledger entry with the
  same amounts. A missing one is reported and re-enqueued through the outbox, so the normal consumer posts it: the
  self-healing path for a lost webhook, a `fee_unavailable` posting and a ledger that was enabled late.
- **Files.** Create `application/commands/reconcile-ledger/checks/{r4-stripe.ts,r4-stripe.spec.ts}`. Modify
  `infrastructure/stripe/stripe.service.ts` (+ spec), `reconcile-ledger.handler.ts`,
  `domains/billing/test/reconcile-ledger.int-spec.ts`.
- **Interfaces.** `StripeService#listBalanceTransactions(window: { from: Date; to: Date }): AsyncIterable<Stripe.BalanceTransaction>`
  (`created` in `[from, to)`, auto-paginated, `expand: ['data.source']`). Entries are found by
  `entryId = ledgerEntryId('stripe:txn:' + id)` in a map of `listEntryRefs(from, now)` over all tenants, so the lookup
  does not depend on the resolved owner and sees entries posted during the grace period. Per transaction:
  - no ref, or a ref whose entry `LedgerPort.getEntry(ref.tenantId, entryId)` does not return → `missing_entry` and one
    record through `enqueueMissingPostings` ("Envelope ids"), under the owner `StripeOwnerResolver` gives for the
    expanded source (platform kinds: the platform tenant); an unresolved owner of a tenant-level kind → both go to the
    platform tenant, with a `tenant_unresolved` finding as well;
  - an entry whose net movement on `asset:stripe_balance` ≠ `net`, whose movement on its fee account ≠ `fee`, or whose
    currency ≠ the transaction's → `stripe_amount_mismatch` under the ref's tenant, with expected and found values.
- **Acceptance tests.** `r4-stripe.spec.ts`: one fixture per reporting category; a missing transaction gives one finding
  and one record with the stated payload, envelope id and key; rerunning the same run id adds no row; the next run,
  while the entry is still missing, enqueues a record with a new id and appends no new discrepancy row; an equal entry
  gives nothing, also when it was posted during the grace period or under another tenant than the resolver now returns;
  a net off by 1 minor unit, another fee or another currency gives `stripe_amount_mismatch`; a
  refund whose PaymentIntent has no metadata lands on the platform tenant with `tenant_unresolved`; three pages are
  read to the end; a Stripe error fails the check and keeps what was already enqueued. `reconcile-ledger.int-spec.ts`
  (added): a transaction with no entry → after the run, a relay tick and the consumer, the entry exists, and the
  following run appends nothing.
- **Dependencies.** Tasks 12, 15. **Lane.** DB. **Review:** yes.

### Task 17: R5: dual-proof advance of the trusted state, verified entries, the pinned key (L-14, D3)

- **Goal.** With `LEDGER_VERIFY=true`, each run proves that immudb's current state extends the state Postgres trusts,
  advances that state by compare-and-set and verifies each new entry against its receipt, so a history rewritten on the
  immudb host is detected. Production refuses an enabled ledger that is not verified against a pinned signing key.
- **Files.** Create `application/commands/reconcile-ledger/checks/{r5-verification.ts,r5-verification.spec.ts}`,
  `domains/billing/test/ledger-verification.int-spec.ts`. Modify `reconcile-ledger.handler.ts`,
  `infrastructure/ledger/{ledger.config.ts,ledger.config.spec.ts,billing-ledger.module.ts,ledger-metrics.ts}`, root
  `.env.example`, `docs/CONFIGURATION.md`.
- **Interfaces.** Binding order, with `db` = the configured immudb database:
  1. `trusted = readTrustedState(db)`; `ledger_unverified_tx_lag` = current tx id − trusted tx id.
  2. `next = LedgerPort.advanceTrustedState(trusted)`: the adapter's dual proof and, when a key is pinned, the state
     signature. A `LedgerVerificationFailedException` → one `verification_failed` under the platform tenant (source key
     `state:<db>`), **no advance**, step 4 skipped, run `failed`.
  3. `advanceTrustedState(db, trusted, next)`; `false` → run `failed`, no finding, no retry.
  4. For each ref from `listEntryRefs` since `min(from, trusted.verifiedAt)` whose tx id is above the old trusted tx id
     or null: `LedgerPort.verifyEntry(entryId, payloadHash, next)`; a failure → `verification_failed` under the ref's
     tenant. Entry failures do not undo step 3.
  5. No trusted row yet: the first state is taken on trust (its signature still checked when a key is pinned), with a
     warning. Guard at module start: in production `LEDGER_ENABLED=true` needs `LEDGER_VERIFY=true` and
     `IMMUDB_SERVER_SIGNING_PUBLIC_KEY`, unless `LEDGER_ALLOW_UNVERIFIED=true`.
- **Acceptance tests.**
  - `r5-verification.spec.ts` (`InMemoryLedger` with tamper hooks, in-memory stores): the first run stores the current
    state; a later run advances it and verifies exactly the refs above the old tx id plus the null-tx ones; an
    inconsistent history → one `verification_failed`, the stored tx id and hash unchanged, no entry verified, run
    `failed`; a trusted state ahead of the store fails the same way; an entry whose hash differs from its ref →
    `verification_failed` under that tenant while the state still advances; a lost compare-and-set → `failed` without
    a finding; `LEDGER_VERIFY=false` → the check does not run and the state is untouched; `ledger_verified_tx_id`
    follows the stored state.
  - `ledger.config.spec.ts` and a module spec: production with the ledger enabled and either `LEDGER_VERIFY=false` or
    no pinned key refuses to start and names both variables; `LEDGER_ALLOW_UNVERIFIED=true` allows it; other
    environments are unaffected.
  - `ledger-verification.int-spec.ts` (immudb Testcontainer started with `--signingKey`, its public key pinned; Citus):
    real proofs advance the state and verify the refs; an adapter pinned to another key → `verification_failed` and no
    advance; a server without a signing key while one is pinned is refused; immudb restarted on an empty volume with
    the old trusted state still in Postgres → `verification_failed` and no advance.
- **Dependencies.** Task 15; W0 L-5, L-9. **Lane.** DB. **Review:** yes.

### Task 18: immudb state signing in compose (D3)

- **Goal.** The compose immudb signs its state with a development key, and both apps pin the matching public key and
  verify, so R5's signed path runs in the local topology. The development key is refused in production.
- **Files.** Create `docker/immudb/{dev-signing-key.pem,dev-signing-key.pub.pem,README.md}`. Modify `docker-compose.yml`
  (immudb `--signingKey` with the mounted key; `x-env-immudb` gains `IMMUDB_SERVER_SIGNING_PUBLIC_KEY`, the apps
  `LEDGER_VERIFY`), `libs/config/src/namespaces/immudb.config.ts`, `libs/config/src/production-guards.spec.ts`,
  `docs/DOCKER.md`, `docs/SECURITY.md` (generating, storing and rotating the key; the trusted state across a rotation).
- **Interfaces.** `IMMUDB_DEV_SIGNING_PUBLIC_KEY` (`@platform/config`), refused in production by `addKnownLocalSecretIssue`.
- **Acceptance tests.** `production-guards.spec.ts`: production with the development public key is refused.
  `scripts/docker/validate-compose.sh` and `scripts/docker/check-infra.sh` pass with the signed immudb. In the isolated
  compose project, one reconcile run with `LEDGER_VERIFY=true` leaves a row in `billing.ledger_trusted_state` (queried
  as `app_system`; the command and its output go in the commit body).
- **Dependencies.** Tasks 14, 17; W0 L-6. **Lane.** A. **Review:** no.

### Task 19: e2e in both topologies, alert rules and the phase docs (L-15, L-13 alerts, the outbox part of G-13)

- **Goal.** One e2e per topology proves the path webhook → outbox → relay → consumer → ledger → reconciliation; alert
  rules cover the outbox and the ledger; the docs describe both as built. Nothing still calls events best-effort except
  `notifications.notification-created.v1`, which has no Postgres store behind it.
- **Files.** Create `apps/monolith/test/ledger.e2e-spec.ts`, `docker/prometheus/rules/{outbox.rules.yml,ledger.rules.yml}`,
  `scripts/prometheus-rules.spec.ts`. Modify `apps/{gateway,billing-service}/test/app.e2e-spec.ts`,
  `docker/prometheus/prometheus.yml` (`rule_files`), `docker-compose.yml` (rules mount),
  `README.md` (outbox note, test count), `domains/billing/README.md` ("Consistency", the ledger),
  `docs/{ARCHITECTURE,SECURITY,TESTING,CONFIGURATION,OBSERVABILITY,API,DOCKER}.md`, `libs/{outbox,transport}/README.md`.
- **Interfaces.** `docs/SECURITY.md` lists the system methods as "System-method lists after this plan". Alerts
  (severity): `OutboxBacklogStuck` (oldest age > 300 s for 5 m, page), `OutboxPublishErrors` (error rate > 0 for 10 m,
  ticket), `OutboxNoLeader` (no `outbox_relay_leader == 1` for 5 m, page), `LedgerDiscrepancy` (any increase in 1 h,
  ticket), `LedgerTamperEvidence` (kind `verification_failed` or `ledger_row_mutated`, page), `LedgerPostConflict`
  (ticket), `LedgerReconciliationStale` (last success older than 3 h, page).
- **Acceptance tests.** `ledger.e2e-spec.ts` (in-memory stores, `FakeKafkaProducer` looped into the consumer,
  `InMemoryLedger`, fake Stripe, `LEDGER_ENABLED=true`): a signed `charge.succeeded` → one outbox row → relay tick → one
  balanced entry and one ref; the same webhook again and the same Kafka message again → still one entry; `payout.paid`
  → a platform entry; a reconcile run → `succeeded` with zero findings; after tampering with the in-memory ledger the
  next run reports `ledger_row_mutated`. Gateway e2e: the forwarded webhook answers as before. billing-service e2e: the
  webhook RPC leaves the posting record, and none with `LEDGER_ENABLED=false`.
  `prometheus-rules.spec.ts`: both rule files parse, exactly these alerts exist with these severities, and every metric
  in an `expr` is one of "Metric names". A search of `README.md`, `docs/`, and the domain and lib READMEs for "no outbox",
  "publish-after-commit" and "best-effort" finds only the notifications note.
- **Dependencies.** Tasks 4, 7, 14, 16, 17, 18. **Lane.** A. **Review:** no.

## Spec deltas (the default taken; the controller may overrule before the wave starts)

1. **New package `@platform/outbox`**, not code in `libs/database` and `libs/transport` (the hotspot table's guess): the
   relay needs both plus Redis, and the gateway must not load a database. It needs one `bun install`.
2. **Outbox purge.** Spec §9 item 6 names only poll and mark-published. Added: `outbox.deletePublishedBefore`, a DELETE
   grant for `app_system` and `OUTBOX_RETENTION_HOURS` (168). Alternative: no purge, and the table grows.
3. **Relay failure rule.** The table has no attempts column, so a batch stops at the first failed publish and a row that
   can never be published blocks its outbox until an operator acts (`OutboxBacklogStuck` pages).
4. **`ledgerAccounts.recordPlatformAccounts`** joins spec §9 item 10: a tenant's charge also opens platform-owned
   accounts, and no listed method could write those rows. It accepts `PLATFORM_TENANT_ID` rows only.
5. **Posting triggers.** LG §2.4 names `checkout.session.completed` and `charge.refunded`, whose objects carry no balance
   transaction: they only move the payment status. Postings key off `charge.succeeded`, `refund.*`,
   `charge.dispute.funds_*` and `payout.*`; R3 and R4 cover a missed event.
6. **Discrepancies.** The id is a deterministic uuidv5 (LG §5 says uuidv7), so a finding identical to a stored one,
   resolved or not, is not appended again. New kinds `post_conflict` and `status_mismatch`. Conflicts are counted in
   `ledger_postings_total{outcome="conflict"}`, not in a second counter. No task writes `resolved` rows (LG §8 has none).
7. **`ledger_entry_refs.immudb_tx_id` is nullable**: a `replayed` outcome has no tx id; R5 verifies those refs too.
8. **Reconciliation grace** of 15 minutes at the window's end; R4 re-enqueues get a new envelope id per run (idempotent).
9. **`LEDGER_ENABLED=false` writes no posting rows.** Enabling it later backfills through one `ReconcileLedgerCommand`
   with an explicit window (R4); Task 19 documents it. S-2 (`request_hash`) is already B2e Task 2: nothing is left here.
10. **Production guard and first trust** (Task 17): `LEDGER_ALLOW_UNVERIFIED` is the only opt-out; the first trusted
    state is taken on first use.
11. **Unprobed** (upstream is unmerged; Docker was not used while planning): `ON CONFLICT DO NOTHING` under insert-only
    RLS on Citus (Task 10 pins the form); Stripe copying PaymentIntent metadata onto charges (Task 12's resolver falls
    back to one GET); immudb starting with `--signingKey` (open in W0 too); the committed development key may need a
    secret-scanner allowlist.

## Rulings (controller, 2026-11-16, auto-run)

1. Accepted: `outbox.deletePublishedBefore`, the `app_system` DELETE grant and `OUTBOX_RETENTION_HOURS` (168).
2. Accepted: `ledgerAccounts.recordPlatformAccounts` (`PLATFORM_TENANT_ID` rows only, nested SystemContext).
3. Accepted: posting triggers on balance-transaction events (`charge.succeeded`, `refund.*`,
   `charge.dispute.funds_*`, `payout.*`). The docs list the webhook event types to subscribe.
4. Accepted: trust on first use, protected by the pinned server signing key, and the production guard.
5. **Overruled (Task 18): no private key is committed.**
   - Compose generates the dev signing key pair at start, in an init job, into a named volume. immudb reads the
     private key from that volume, and the app reads the public key from a mounted file. The public key is also
     accepted as file content through an `IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE` variant of the existing env key.
   - Int and e2e specs generate their own key pair at test time.
   - Reason: a committed private key trips secret scanning and push protection, and invites copy-paste into
     production.
