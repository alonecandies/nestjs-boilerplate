# Stripe idempotency hardening, immudb ledger and reconciliation: design

Status: ruled and reconciled (2026-11-09): decisions in "Decisions (ruled 2026-11-09)", reconciliation with the
sharding design in section 9, folded into the program spec (its section 16). Design lane design:ledger. Branch
`feat/domains-tenancy` at `9600510`.

## Executive summary

- **Client path: generated gRPC, not pg-wire** (probed on `codenotary/immudb:1.11.2`). pg-wire (default on, 5432,
  cleartext) needs postgres.js `prepare: false` + `fetch_types: false`; tx, aggregates and MVCC conflicts work, but
  `sql.begin` masks errors, no tx id or proofs come back, `GRANT`/`REVOKE` silently do nothing, and
  timestamps/booleans decode wrongly. The ts-proto client generated from the stripped `schema.proto` type-checks with
  0 errors. Sessions, tx with commit tx ids, read-check-insert races, `ChangeSQLPrivileges` (the ledger user cannot
  UPDATE/DELETE/DROP) and `VerifiableTxById`/`VerifiableSQLGet` all worked.
- **Verification** is a port from the Go SDK (immudb-node 1.1.1 is too old): 3 tasks on top of 2 client tasks (D1).
- **Stripe audit, 11 gaps.** High: S-5 (completion records a `?? 0` amount and never compares with the quote), S-6
  (refunds, disputes, payouts, fees ignored). Medium: S-1 (a replay after Stripe's 24 h window creates an orphan
  session and returns 409), S-2 (2 of 6 request fields compared), S-3 (in-flight 409 reported as "reused"), S-4
  (per-user scope), S-7 (best-effort relay).
- **Ledger.** immudb tables `ledger_accounts`, `ledger_entries`, `ledger_postings`: int64 minor units, debit/credit
  columns, µs times, no PII, one database per environment, currency on every row. One entry per Stripe balance
  transaction, id = uuidv5(`stripe:txn:<id>`), fees from the balance transaction. Before any I/O the adapter checks
  Σdebit = Σcredit per currency. One ReadWrite tx then gives `replayed` (same hash), `conflict` (different hash:
  discrepancy + alert) or `posted`; `tx read conflict` means retry.
- **Exactly-once effect.** The webhook transaction writes a `billing.ledger-posting.v1` outbox row (G-2). The G-3
  relay sends it to Kafka and a billing consumer posts it as the envelope principal. No dual writes; nothing posts
  before the outbox (`LEDGER_ENABLED=false`).
- **Reconciliation** (hourly system cron): R1 invariant, R2 no `HISTORY OF` revision > 1, R3 payments vs entries,
  R4 Stripe balance transactions vs entries (re-enqueue missing), R5 dual-proof advance of a Postgres-held trusted
  state plus verified per-entry reads. Findings go to an append-only, RLS-scoped `billing.ledger_discrepancies`.
  Metrics and alerts follow G.
- **Tenancy.** A tenant id on every immudb row (nil UUID = platform), checked in code (immudb has no RLS). A database
  per tenant is rejected. Five Postgres tables: three tenant-scoped under RLS, two system-only. Four new system
  methods for spec section 9.
- **Placement.** `@platform/immudb` (ledger-agnostic client, migrator, verification) + the `immudb` platform config
  namespace. Model, rules, adapter, fake, consumer and cron go in `domains/billing`. Compose runs pg-wire off with
  readiness via `/readyz` (distroless image, no exec healthcheck). Testcontainers int specs + a shared contract spec.
- **15 tasks (L-1..L-15).** Wave 0 starts now, in parallel to B2: client, verification, compose, schema-free Stripe
  fixes, model/fake, adapter. Wave 1 after B2-6/SH-6/B3/G-1/G-2; wave 2 after G-3/G-4.
- **B2 must carry (ruled, D5):** B2-6 adds `payments.request_hash`, a tenant-scoped idempotency unique, a nullable
  `stripe_events.user_id` with PK `(tenant_id, id)`, and the new payment statuses; B2-1 reserves the nil UUID
  (`PLATFORM_TENANT_ID`) with a CHECK on `identity.tenants.id`. B2-26 adds `tenantId` to the PaymentIntent metadata.
- **Citus (reconciled with the sharding design):** payments, stripe_events, outbox and the three tenant ledger tables
  are distributed by `tenant_id`; runs and trusted state are coordinator-local. The RLS context is `SET LOCAL`, and
  the relay is a single active instance with router mark-published (section 7).

## Client-path verdict

**Recommendation: one typed gRPC client (`@platform/immudb`, generated from immudb's `schema.proto` at `v1.11.2`
with this repo's buf 1.73.0 + ts-proto 2.13.3 + @grpc/grpc-js 1.14.6), used for writes, reads, provisioning and
verification. Do not build the production path on the pg-wire server.** Both paths were probed against
`codenotary/immudb:1.11.2` (Appendix P1-P7).

| Question           | a) pg-wire + postgres.js 3.4.9                                                                                                                                                                                                                                                                                         | b) gRPC (generated)                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect            | Works only with `prepare: false` **and** `fetch_types: false` (default boot query fails: `column does not exist (typarray)`, P1). Server on 5432, enabled by default (`--pgsql-server`, `--pgsql-server-port`); it logs "running WITHOUT TLS. Client passwords will be transmitted in cleartext".                      | `OpenSession` / `KeepAlive` / `CloseSession`, metadata `sessionid` (P6). Sessions expire after 3 min idle (`--max-session-inactivity-time`), cap 100 (`--max-sessions`).                                                                                               |
| Transactions       | `BEGIN`/`COMMIT` work; rollback on app error works (P2). **Any failed statement kills the server tx**: the next `COMMIT`/`ROLLBACK` fails with `no ongoing transaction`, which **masks the original error** inside `sql.begin` (P2, P3). Needs `sql.reserve()` + manual `BEGIN`/`COMMIT`. No commit tx id is returned. | `NewTx(ReadWrite)` → metadata `transactionid` → `TxSQLExec`/`TxSQLQuery` → `Commit` returns `CommittedSQLTx.header.id` (the immudb tx id, needed for proofs) (P6).                                                                                                     |
| PK conflict        | Error `key already exists`, **no SQLSTATE code** (P2).                                                                                                                                                                                                                                                                 | gRPC status 2 (UNKNOWN), details `key already exists` (P6). Same string match in both paths.                                                                                                                                                                           |
| Concurrency        | MVCC: two txs inserting the same PK → one gets `tx read conflict`; read-check-write race on the same `entry_id` → `tx read conflict: fetching more entries than expected` (P2).                                                                                                                                        | Same engine.                                                                                                                                                                                                                                                           |
| Params, aggregates | Positional params bind; `SUM`/`COUNT` + `GROUP BY` + `HAVING` work; values come back as strings (P1). **`TIMESTAMP` params/results shift by the host offset (+7 h here) and `BOOLEAN` always reads `false`** (P2, P3).                                                                                                 | Named params `@x` with typed `SQLValue` (`n` int64, `s`, `ts`, `b`, `bs`) (P6).                                                                                                                                                                                        |
| Append-only        | `UPDATE`/`DELETE`/`UPSERT`/`DROP` are legal SQL; `HISTORY OF t` shows every revision (P2). **`GRANT`/`REVOKE` over pg-wire return OK and change nothing** (P4).                                                                                                                                                        | `ChangeSQLPrivileges(REVOKE, [UPDATE, DELETE, DROP, ALTER, CREATE])` works: the ledger user then gets `access denied: statement requires [UPDATE] privileges` for UPDATE/DELETE/UPSERT/DROP/CREATE and can still INSERT/SELECT (P6, P7).                               |
| Tamper evidence    | None (no proofs on this protocol).                                                                                                                                                                                                                                                                                     | `CurrentState`, `VerifiableTxById` (dual proof), `VerifiableSQLGet` (row + inclusion + dual proof) all answer (P6). Client-side verification must be ported (below). Server state is unsigned unless immudb runs with a signing key (`signature: null`, P6).           |
| Codegen            | none                                                                                                                                                                                                                                                                                                                   | Upstream proto imports `google/api/annotations.proto` and swagger options; after stripping the 59 `option (...)` blocks, `buf generate` with ts-proto (`outputServices=grpc-js`) emits 18,424 lines that pass this repo's `tsc` strict base config with 0 errors (P5). |

SQL subset that applies (both paths, immudb SQL): `CREATE TABLE … PRIMARY KEY (…)`, `VARCHAR[n]`, `INTEGER`
(int64), `UUID`, `JSON`, `BLOB`, `TIMESTAMP`, `BOOLEAN`; `CREATE [UNIQUE] INDEX IF NOT EXISTS ON t(cols)`;
`INSERT`, `UPSERT`, `UPDATE`, `DELETE`; `SELECT … WHERE … GROUP BY … HAVING … ORDER BY … LIMIT`; `COUNT/SUM/MIN/
MAX/AVG`; time travel `SINCE TX n`, `BEFORE TX n`, `HISTORY OF t` (with `_rev`); `CREATE DATABASE IF NOT EXISTS`,
`CREATE USER`. No sequences, no foreign keys; an inline `CHECK (amt >= 0)` parses but a violating row was accepted
(P4), so **every invariant (balance, non-negative amounts) lives in the adapter and in reconciliation**.

Port size for client-side verification (Go SDK `v1.11.2`, Apache-2.0; `immudb-node` 1.1.1 predates SQL row
verification and `LinearAdvanceProof`, so port from Go): `embedded/store/verification.go` (372 lines:
`VerifyInclusion`, `VerifyLinearProof`, `VerifyLinearAdvanceProof`, `VerifyDualProof`, `EntrySpecDigest_v0/v1`),
`embedded/ahtree/verification.go` (137), the tx header Alh/inner-hash and metadata encodings from
`embedded/store/tx.go`, `tx_metadata.go`, `kv_metadata.go`, and `pkg/client/sql.go` `VerifyRow` (`:130-288`: SQL
key `MapKey(…EncodeID(db), EncodeID(table), EncodeID(PKIndexID), pk)` + row value decoding). Estimate: **3 tasks**
(proof primitives with Go-generated test vectors; SQL row encoding + `verifyRow`; trusted-state store in Postgres +
verified reconciliation), on top of **2 client tasks** (vendored proto + codegen; session pool + tx + error map).
Risk: medium (byte-exact hashing; mitigated by golden vectors captured from the Go SDK and by an int spec against
the real container, including a negative test that flips one proof byte).

Binding adapter rules derived from the probes are listed at the end of the appendix (A1).

Verdict: pg-wire can do transactions but its gotchas (masked errors, no tx id, no proofs, silent GRANT, timestamp
and boolean decoding, cleartext auth) make it a debugging aid only (`psql`). gRPC gives one client for everything.
Without the 3 verification tasks the ledger is "append-only by server promise" plus SQL privileges plus
`HISTORY OF` checks; with them it is tamper-evident against a trusted state kept outside immudb. Total client work
is 5 tasks, at the edge of the 4-5 budget. Ruled 2026-11-09 (D1): L-4/L-5 are built in wave 0 and R5 is switched on
in wave 2.

## 1. Stripe idempotency audit

Scope read at `9600510`: `domains/billing/src/**`, `apps/billing-service/src/**`, the gateway's billing wiring, the
monolith's `rawBody` boot (`apps/monolith/src/main.ts:29-31`). Paths below are relative to `domains/billing/src/`
unless they start with `apps/` or `docs/`.

### 1.1 What exists and holds

- **Checkout client key.** Optional `Idempotency-Key` header, 8-255 chars of `[A-Za-z0-9._:-]`
  (`presentation/http/request-headers.decorator.ts:12-16`, `billing.constants.ts:39-48`). The handler inserts a
  `pending` payment with `ON CONFLICT DO NOTHING` on the unique `(user_id, idempotency_key)` index
  (`infrastructure/persistence/drizzle-payments.repository.ts:85-109`, `migrations/0000_init.sql:30`); a replay
  finds the existing row, `matchesRequest` compares price and quantity
  (`domain/payment.aggregate.ts:170-172`), and a mismatch is `IDEMPOTENCY_KEY_REUSED` (409)
  (`application/commands/create-checkout-session/create-checkout-session.handler.ts:55`).
- **Outbound Stripe key.** The only outbound write is `checkout.sessions.create`, keyed `checkout-${paymentId}`
  (`create-checkout-session.handler.ts:22`, `:85`; `infrastructure/stripe/stripe.service.ts:27-50`), never the raw
  client key (Stripe keys are account-wide). The SDK retries 409/429/5xx with its own keys
  (`maxNetworkRetries`, `infrastructure/stripe/stripe.module.ts:14-21`).
- **Webhook.** HMAC verification over the raw bytes with a 5-minute tolerance (`stripe.service.ts:60-88`), then
  one transaction: `stripe_events` insert-or-skip (`drizzle-stripe-events.repository.ts:14-21`) plus the row-locked
  payment transition (`drizzle-payments.repository.ts:116-131`), domain events published after commit
  (`handle-stripe-webhook.handler.ts:62-72`). Infra errors roll back and Stripe redelivers; unknown payments and
  impossible transitions are acknowledged with a warning (`:132-156`). Out-of-order replays are absorbed by the
  aggregate returning `false` (`payment.aggregate.ts:216-261`).
- **Purge.** Hourly, Redis-locked, 30-day retention, 5,000-row batches
  (`infrastructure/scheduling/purge-stripe-events.cron.ts:26-41`, `billing.constants.ts:54-59`).

### 1.2 Gap list

| Id   | Severity | Gap (evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fix                                                                                                                                                                                                                                                                                                              | Needs schema?                |
| ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| S-1  | Medium   | **A replay after Stripe's 24 h key window creates a second session.** The handler always calls `sessions.create` (`create-checkout-session.handler.ts:57`), even when the payment already has a session; Stripe forgets keys after 24 h, so a late replay creates a new session and `attachCheckoutSession` throws `CHECKOUT_SESSION_MISMATCH` (`payment.aggregate.ts:183-185`). The legitimate retry gets a 409, and an orphan payable session exists in Stripe with no record (its URL is not returned, so payment is unlikely; if it were paid, `complete()` would refuse it, `:219`, and only R4 would surface it). | When `stripeCheckoutSessionId` is set, `sessions.retrieve(id)` and return it (URL included; `expired`/`complete` → 409 `CHECKOUT_SESSION_CLOSED`). Never create a second session for a payment.                                                                                                                  | No                           |
| S-2  | Medium   | **Payload mismatch is checked on 2 of 6 fields.** `customerEmail`, `successUrl`, `cancelUrl` reach Stripe from the request (`create-checkout-session.handler.ts:77-83`), not from the stored payment; a replay with a different URL passes `matchesRequest` and then fails at Stripe as `StripeIdempotencyError` within 24 h, or silently differs after.                                                                                                                                                                                                                                                                | Store `request_hash` (sha256 of the normalized request: price, quantity, email, URLs) on the payment; compare it on replay; build the Stripe params from the stored payment.                                                                                                                                     | Yes (B2-6)                   |
| S-3  | Medium   | **Concurrent duplicates surface as "reused".** Two in-flight requests with one key both reach Stripe; the loser's `idempotency_key_in_use` 409 maps to `IDEMPOTENCY_KEY_REUSED` like a real mismatch (`infrastructure/stripe/stripe.errors.ts:24-30`).                                                                                                                                                                                                                                                                                                                                                                  | Map Stripe `code === 'idempotency_key_in_use'` to a retryable `CHECKOUT_IN_PROGRESS` (409 + `Retry-After`); or serialize on the payment row (`SELECT … FOR UPDATE NOWAIT`) before calling Stripe.                                                                                                                | No                           |
| S-4  | Medium   | **Scope and lifetime.** The key is unique per user (`0000_init.sql:30`), not per tenant, and lives as long as the payment row (no TTL, never purged). A missing header means no idempotency at all.                                                                                                                                                                                                                                                                                                                                                                                                                     | B2-6: unique `(tenant_id, user_id, idempotency_key)`. Document "key lifetime = payment lifetime". Keep the header optional (API compatibility) but log and count requests without it.                                                                                                                            | Yes (B2-6)                   |
| S-5  | High     | **No amount or currency check on completion, and a `0` fallback.** `complete()` takes the event's `amount_total` and falls back to `0` when it is null (`payment.aggregate.ts:221-231`), so a paid payment can be recorded and announced as 0; a paid amount that differs from the quote passes silently.                                                                                                                                                                                                                                                                                                               | Record Stripe's paid amount and currency (they are what was charged: promotion codes, tax and price changes are legitimate). When they differ from the stored quote, count `billing_checkout_amount_mismatch_total` and write a discrepancy (section 4). Refuse only a null amount or currency; drop the `?? 0`. | No (discrepancy table later) |
| S-6  | High     | **Refunds, disputes, payouts and fees are invisible.** The webhook switch handles four `checkout.session.*` types (`handle-stripe-webhook.handler.ts:86-129`); `charge.refunded`, `refund.*`, `charge.dispute.*`, `payout.*`, `payment_intent.payment_failed` are ignored; no code reads a balance transaction, so Stripe fees are never known.                                                                                                                                                                                                                                                                         | Section 2.4 posting rules; webhook coverage task L-11; reconciliation against balance transactions (R4). Payment statuses gain `refunded`/`partially_refunded`/`disputed` (enum `ADD VALUE` in B2-6's or a later stacked migration).                                                                             | Yes (enum)                   |
| S-7  | Medium   | **Best-effort event delivery.** `PaymentSucceededRelay` publishes after commit and swallows errors (`application/relays/payment-succeeded.relay.ts:18-49`): a crash between commit and publish loses `billing.payment-succeeded.v1`.                                                                                                                                                                                                                                                                                                                                                                                    | G-1..G-3 outbox (spec section 12). The ledger never consumes this relay; it consumes its own outbox topic (section 3).                                                                                                                                                                                           | G                            |
| S-8  | Low      | **The event payload cannot locate money.** `PaymentSucceededPayload` carries the session id, amount and currency but no PaymentIntent or charge id (`contracts/src/events/billing.events.ts:8-12`); the payment row stores the PaymentIntent id but not the charge or balance transaction.                                                                                                                                                                                                                                                                                                                              | Add optional `stripePaymentIntentId` to the v1 payload (non-breaking); the ledger topic carries Stripe object ids directly.                                                                                                                                                                                      | No                           |
| S-9  | Low      | **Unknown types consume a dedupe row** (insert precedes the switch, `handle-stripe-webhook.handler.ts:76-83`): an event type added later is never replayed from history. Accepted: R4 reconciles from Stripe's balance transactions, not from webhooks. Purge at 30 days is safe for the ledger because entry ids are deterministic (a resend after purge replays idempotently).                                                                                                                                                                                                                                        | Document; no change.                                                                                                                                                                                                                                                                                             | No                           |
| S-10 | Low      | **API version follows the SDK** (`stripe.module.ts:8-13`): event shapes change on SDK upgrades unless the dashboard endpoint is pinned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Pin `apiVersion` explicitly and assert the event's `api_version` equals it (count mismatches).                                                                                                                                                                                                                   | No                           |
| S-11 | Info     | **Money.** Postgres `bigint` read as TS `number` (`infrastructure/persistence/billing.schema.ts:45`), event `z.number().int()` (`billing.events.ts:9-10`): safe below 2^53.                                                                                                                                                                                                                                                                                                                                                                                                                                             | Ledger uses `bigint` end to end (immudb `INTEGER` is int64 and round-trips as a string, P2).                                                                                                                                                                                                                     | No                           |

Checkout answers in one line each: a replay returns the same session (yes within 24 h; S-1 after); payload mismatch
(partly, S-2); concurrent duplicates (one wins, the other sees a misleading 409, S-3); scope (per user, S-4);
storage (the `billing.payments` row); TTL (none on our side, 24 h on Stripe's).

## 2. Ledger model in immudb SQL

### 2.1 Shape and deployment

- **One immudb database per environment** (`IMMUDB_DATABASE`, default `ledger`), on an immudb instance per
  environment. Not one database per currency: "one ledger per currency" means every account and posting carries
  `currency`, and every invariant is evaluated per `(entry, currency)` and per currency overall.
- **Money** is `INTEGER` (int64) minor units, always positive; direction is a `debit`/`credit` column pair (one is 0).
  TypeScript uses `bigint`. Times are `INTEGER` epoch microseconds (no `TIMESTAMP`, see P3).
- **No PII.** immudb cannot erase. Rows hold tenant, payment and Stripe ids, amounts, currencies and hashes only;
  never emails, names or card data. GDPR erasure stays in Postgres; ledger rows stay pseudonymous.
- **Retention.** Keep everything for the statutory period (assume 10 years); do not configure truncation. Durability
  from `--synced` (default true) plus immudb replication (`--replication-*`, P8) or volume snapshots; backup is an
  ops concern documented in `docs/DOCKER.md`.

### 2.2 Tables (immudb migration `001_ledger.sql`, applied by the `@platform/immudb` migrator)

```sql
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id             VARCHAR[36],   -- uuidv5(LEDGER_NS, 'account:' || owner_tenant_id || ':' || code || ':' || currency)
  owner_tenant_id VARCHAR[36],  -- PLATFORM_TENANT_ID for platform accounts
  code           VARCHAR[64],   -- chart code, section 2.3
  currency       VARCHAR[3],    -- lowercase ISO 4217
  kind           VARCHAR[16],   -- asset | liability | equity | revenue | contra_revenue | expense
  created_at_us  INTEGER,
  PRIMARY KEY id
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id             VARCHAR[36],   -- uuidv5(LEDGER_NS, source_key): the idempotency key
  source_key     VARCHAR[128],  -- 'stripe:txn:txn_…' (human-readable origin)
  tenant_id      VARCHAR[36],   -- attribution tenant; PLATFORM_TENANT_ID for payouts and platform fees
  kind           VARCHAR[32],   -- charge | refund | refund_failure | dispute | dispute_reversal | payout | payout_failure | stripe_fee | adjustment
  payment_id     VARCHAR[36],   -- billing.payments.id or ''
  stripe_object  VARCHAR[64],   -- ch_…, re_…, du_…, po_…
  presentment_amount   INTEGER, -- what the customer paid, in presentment currency (0 when n/a)
  presentment_currency VARCHAR[3],
  payload_hash   VARCHAR[64],   -- sha256 hex of the canonical entry (2.5)
  occurred_at_us INTEGER,       -- Stripe balance transaction `created`
  recorded_at_us INTEGER,
  schema_version INTEGER,
  PRIMARY KEY id
);
CREATE INDEX IF NOT EXISTS ON ledger_entries(tenant_id);
CREATE INDEX IF NOT EXISTS ON ledger_entries(payment_id);
CREATE INDEX IF NOT EXISTS ON ledger_entries(recorded_at_us);
CREATE TABLE IF NOT EXISTS ledger_postings (
  id             VARCHAR[40],   -- entry_id || ':' || line (single-column PK: composite PKs were not probed)
  entry_id       VARCHAR[36],
  line           INTEGER,
  tenant_id      VARCHAR[36],   -- = ledger_entries.tenant_id (denormalized for tenant-scoped sums)
  account_id     VARCHAR[36],
  currency       VARCHAR[3],
  debit          INTEGER,
  credit         INTEGER,
  PRIMARY KEY id
);
CREATE INDEX IF NOT EXISTS ON ledger_postings(entry_id);
CREATE INDEX IF NOT EXISTS ON ledger_postings(tenant_id, account_id);
CREATE INDEX IF NOT EXISTS ON ledger_postings(account_id);
```

The ledger user is provisioned with `SELECT` and `INSERT` only (`ChangeSQLPrivileges REVOKE UPDATE, DELETE, DROP,
ALTER, CREATE`, P6/P7): `UPDATE`, `DELETE`, `UPSERT` and DDL are refused by the server. Migrations run as the admin
user.

### 2.3 Chart of accounts (Stripe Checkout, single Stripe account, platform sells to tenants)

| Code                      | Kind           | Owner    | Meaning                                                              |
| ------------------------- | -------------- | -------- | -------------------------------------------------------------------- |
| `asset:stripe_balance`    | asset          | platform | Funds held by Stripe (pending + available): the clearing account     |
| `asset:bank`              | asset          | platform | Payout destination bank account                                      |
| `revenue:checkout`        | revenue        | tenant   | Gross sales to that tenant (a tenant sub-ledger of platform revenue) |
| `contra_revenue:refunds`  | contra_revenue | tenant   | Refunds granted to that tenant                                       |
| `contra_revenue:disputes` | contra_revenue | tenant   | Disputed amounts withdrawn (reversed on reinstatement)               |
| `expense:stripe_fees`     | expense        | platform | Processing fees, from the balance transaction `fee`                  |
| `expense:dispute_fees`    | expense        | platform | Dispute fees                                                         |
| `equity:adjustments`      | equity         | platform | Stripe `adjustment` balance transactions without a known source      |

If the product later becomes a marketplace (Stripe Connect), `revenue:checkout` becomes `liability:tenant_payable`;
out of scope here.

### 2.4 Posting rules (one entry per Stripe balance transaction)

Every money movement in Stripe is a balance transaction (`txn_…`) in the **settlement** currency with `amount`,
`fee`, `net`. One ledger entry per balance transaction, `source_key = 'stripe:txn:<txn_id>'`, posts in that
currency, so every entry balances per currency by construction; the presentment amount and currency (what
`billing.payments` stores) go in `presentment_*` for reconciliation R3. The tenant comes from the source object's
metadata (`payment_intent_data.metadata`, already set at `stripe.service.ts:40`, gaining `tenantId` in B2-26);
platform-level transactions use `PLATFORM_TENANT_ID`.

| Trigger (webhook → outbox)                                                                       | Balance transaction                         | Lines (D = debit, C = credit)                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed` (paid) / `async_payment_succeeded` → charge's `balance_transaction` | `charge`/`payment`                          | D `asset:stripe_balance` amount; C `revenue:checkout` amount; D `expense:stripe_fees` fee; C `asset:stripe_balance` fee |
| `charge.refunded`, `refund.updated` (status `succeeded`)                                         | `refund`/`payment_refund` (negative amount) | D `contra_revenue:refunds` abs(amount); C `asset:stripe_balance` abs(amount); fee lines if `fee` ≠ 0                    |
| `refund.failed`                                                                                  | `refund_failure`                            | reverse of the refund lines (new entry, never a mutation)                                                               |
| `charge.dispute.funds_withdrawn`                                                                 | `adjustment` (dispute)                      | D `contra_revenue:disputes` abs(amount); D `expense:dispute_fees` fee; C `asset:stripe_balance` abs(amount)+fee         |
| `charge.dispute.funds_reinstated`                                                                | `adjustment` (dispute)                      | D `asset:stripe_balance` amount; C `contra_revenue:disputes` amount                                                     |
| `payout.paid`                                                                                    | `payout` (negative)                         | platform: D `asset:bank` abs(amount); C `asset:stripe_balance` abs(amount); fee lines for instant payouts               |
| `payout.failed` (after paid)                                                                     | `payout_failure`                            | reverse of the payout                                                                                                   |
| none (found by R4)                                                                               | `stripe_fee`, `adjustment`, other           | platform: `expense:stripe_fees` or `equity:adjustments` against `asset:stripe_balance`                                  |

`charge.dispute.closed`, `checkout.session.expired` and `async_payment_failed` move no money and post nothing.
Fees come only from the balance transaction (`stripe.balanceTransactions.retrieve`, a GET, naturally idempotent);
for async methods the balance transaction can lag: the poster retries with backoff and, after the outbox retry
budget, writes a `fee_unavailable` discrepancy (R4 posts it later).

### 2.5 Idempotency and the double-entry invariant (adapter, before commit)

1. **Validate** the draft in TypeScript, before any I/O: ≥ 2 lines, every amount a positive `bigint`, every line's
   currency a 3-letter code, every line's account owner is the entry's tenant or `PLATFORM_TENANT_ID`, and **per currency Σdebit = Σcredit**. Failure
   throws `LedgerUnbalancedException` (a programming error: no discrepancy row, the outbox message dead-letters).
2. **Ids.** `entryId = uuidv5(LEDGER_NAMESPACE, sourceKey)` (the `uuid` package is in the catalog, `package.json:123`);
   `payloadHash = sha256(canonicalJson({ sourceKey, tenantId, kind, paymentId, stripeObject, presentment,
occurredAtUs, lines: [{ accountId, currency, debit, credit }] }))` with sorted keys and bigints as decimal strings.
   `recorded_at_us` is excluded so a replay hashes the same.
3. **One `ReadWrite` tx** (P8 pattern): `SELECT payload_hash FROM ledger_entries WHERE id = @id`.
   - Present, equal hash → `Rollback`, outcome `replayed`.
   - Present, different hash → `Rollback`, outcome `conflict` (the caller appends a discrepancy and counts
     `ledger_post_conflicts_total`; the outbox message is acknowledged: retrying cannot help).
   - Absent → ensure accounts (`SELECT` then `INSERT` by deterministic id), `INSERT` the entry and its postings,
     `Commit` → outcome `posted` with the immudb tx id.
4. **Races.** `tx read conflict…` (the loser of two concurrent posts, P2/P8) → retry from step 3 in a new tx (up to 5
   times, jittered); the retry then sees the row and returns `replayed` or `conflict`. `key already exists` after an
   absent read is treated the same way. Never call `Rollback` after a failed statement (the server already ended
   the tx).
5. Reconciliation R1 re-verifies the invariant from immudb itself, so a bug in step 1 or a write by another client is
   still caught.

## 3. Where postings happen: the transactional outbox

- **No dual writes.** The webhook transaction never calls immudb. In the same Postgres transaction as the
  `stripe_events` insert and the payment transition, it inserts an outbox row (G-2) on topic
  **`billing.ledger-posting.v1`** (key `tenantId`, envelope id `uuidv5(LEDGER_NAMESPACE, stripeEventId)`).
- **Carrier (ruled, D2): the G-3 relay publishes it to Kafka; a billing consumer posts it.** The relay is the
  program's single relay under Citus (sharding design section 7.4): one active instance per domain set (Redis lock),
  system pool, a multi-shard poll without row locks, publish outside any transaction, router mark-published by
  `(tenant_id, id)`; at-least-once, and a leadership handover may resend. `LedgerPostingConsumer` (billing messaging
  module, like `domains/notifications/src/notifications-messaging.module.ts`) runs as the `{ userId, tenantId }`
  principal from the envelope (spec section 9's webhook rule) when both are present; a platform-tenant or user-less
  message runs in `SystemContext` and writes its Postgres rows through the system methods of section 5. It fetches
  the balance transaction from Stripe, applies the posting rules and calls `LedgerPort.post`. At-least-once delivery
  plus deterministic entry ids gives an **exactly-once effect**. Failures retry by redelivery; poison messages go to
  `billing.ledger-posting.v1.dlq`.
- **Rejected alternative: a second, dedicated outbox poller** that calls the poster in-process (no Kafka hop). It
  couples the relay's claim loop to Stripe and immudb latency.
- **Receipt.** After `posted` or `replayed`, the consumer inserts `billing.ledger_entry_refs` (section 5) with the
  immudb tx id: that is the Postgres-side index of what was posted, used by R3 and by verification.
- **Nothing posts before the outbox exists.** Until G-1..G-3 land, `LEDGER_ENABLED=false` and no posting code path is
  wired; the client library, model, fake and adapter can be built and tested in isolation (wave 0).
- Platform-level events (`payout.*`, unattributed `stripe_fee`) have no tenant principal: their `stripe_events` and
  outbox rows are written through the system pool with `PLATFORM_TENANT_ID` and `user_id` NULL (new system methods,
  section 5).
- A tenant-level event type that arrives without tenant metadata is acknowledged with a warning, as an unknown
  payment is today; R4 later finds its balance transaction and the posting lands on the platform tenant, with a
  `tenant_unresolved` discrepancy.

## 4. Reconciliation (scheduled, system context)

`ReconcileLedgerCron` (hourly, `@WithLock` like `purge-stripe-events.cron.ts:26-31`) runs `ReconcileLedgerCommand`
inside `SystemContext` (B3-10) over a window `[from, to)` (default lookback 3 days, overlapping, idempotent). Each
check appends findings to `billing.ledger_discrepancies`; nothing is ever corrected in place.

| Check                              | Source of truth                                                              | Query / method                                                                                                                                                                                                                                                                                                                                | Discrepancy kinds                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 invariant                       | immudb                                                                       | `SELECT entry_id, currency, SUM(debit), SUM(credit) FROM ledger_postings … GROUP BY entry_id, currency HAVING SUM(debit) <> SUM(credit)` (probed, P2); global `GROUP BY currency` totals; entries with < 2 postings                                                                                                                           | `unbalanced_entry`, `unbalanced_currency`                                                                                                                                                                |
| R2 mutation                        | immudb                                                                       | `SELECT id, _rev FROM (HISTORY OF ledger_entries) WHERE _rev > 1` (and postings, accounts) (P2)                                                                                                                                                                                                                                               | `ledger_row_mutated` (the `_rev > 1` filter was not probed, only `HISTORY OF … WHERE id =`: verify in the L-9 int spec; the full-history scan is O(all rows), make it incremental with `SINCE TX` later) |
| R3 Postgres ↔ ledger               | `billing.payments` (succeeded in window) and `billing.ledger_entry_refs`     | every succeeded payment has a `charge` entry whose `presentment_amount/currency` and tenant equal the payment's; every `charge` entry maps to a payment; refunded/disputed statuses match entry kinds                                                                                                                                         | `payment_without_entry`, `entry_without_payment`, `amount_mismatch`, `tenant_mismatch`                                                                                                                   |
| R4 Stripe ↔ ledger                 | Stripe `balanceTransactions.list({ created: { gte, lt } })` (auto-paginated) | every balance transaction has entry `uuidv5('stripe:txn:'+id)` with equal amount, fee, net, currency; a missing one gets an outbox row (system pool), so the normal poster posts it                                                                                                                                                           | `missing_entry` (self-healing), `stripe_amount_mismatch`, `fee_unavailable`, `tenant_unresolved`                                                                                                         |
| R5 tamper evidence (needs L-4/L-5) | trusted state in Postgres                                                    | `CurrentState` → `VerifiableTxById(tx = current, proveSinceTx = trusted)` → verify dual proof (and the state signature when `--signingKey` is set, against the pinned public key) → advance `billing.ledger_trusted_state`; then `VerifiableSQLGet` each `ledger_entry_refs` row with `immudb_tx_id > trusted` and compare its `payload_hash` | `verification_failed` (page)                                                                                                                                                                             |

- **Discrepancy table** `billing.ledger_discrepancies` is append-only (runtime role has no `UPDATE`/`DELETE` grant),
  tenant-scoped under RLS; a resolution is a new row (`kind = 'resolved'`, `resolves_id`).
- **Metrics** (G-4 registry): `ledger_postings_total{outcome=posted|replayed|conflict}`,
  `ledger_post_duration_seconds`, `ledger_discrepancies_total{kind}`, `ledger_reconciliation_runs_total{status}`,
  `ledger_reconciliation_last_success_timestamp_seconds`, `ledger_verified_tx_id`, `ledger_unverified_tx_lag`,
  `billing_checkout_amount_mismatch_total` (S-5). Alerts: any `ledger_discrepancies_total` increase (ticket),
  `verification_failed` or `ledger_row_mutated` (page), last success older than 3 intervals (page), conflicts > 0.
- Without R5 (verification not yet ported) the ledger is append-only by server privileges plus R2; R5 makes a
  history rewrite by the immudb host itself detectable, because the trusted state lives outside immudb.

## 5. Tenancy and RLS

- **Every immudb row carries a tenant** (`ledger_entries.tenant_id`, `ledger_postings.tenant_id`,
  `ledger_accounts.owner_tenant_id`); platform rows use `PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000'`
  (B2-1 reserves it: a CHECK keeps it out of `identity.tenants.id`, and the RLS context builder refuses it as a
  runtime tenant). All platform rows in Postgres land on one shard; that is acceptable because platform events are
  low-volume, and RLS needs no extra branch: runtime policies require `tenant_id = app.tenant_id()`, which is never
  the nil UUID, so only the system pool reads or writes platform rows (sharding design rule 2.1.8).
- **immudb has no RLS**, so tenancy is enforced in code: `LedgerService` (billing application layer) takes the tenant
  from the CLS principal and passes it explicitly; the adapter has no API without a `tenantId` argument and adds
  `tenant_id = @tenant` to every tenant read; posting asserts the draft's tenant equals the principal's;
  `PLATFORM_TENANT_ID` reads and posts are allowed only inside `SystemContext`. A unit spec pins that every adapter
  SQL string for tenant reads contains the tenant predicate.
- **Database per tenant, rejected.** `--max-active-databases` defaults to 100 (P8); each database has its own files,
  indexes and session scope; payouts, fees and reconciliation span all tenants; provisioning per tenant would need
  per-tenant users. A tenant column with code checks is the right shape.
- **Postgres tables** (billing schema, one stacked migration in L-10 after B2-6, SH-6, B3-6 and G-1; Citus kinds
  from the sharding design section 2.3: T = distributed by `tenant_id`, colocated with `app.tenant_colocation` and
  distributed inline right after each `CREATE TABLE`; L = coordinator-local, no distribution call). No FKs: billing
  has no cross-domain FK, and a distributed table cannot reference a coordinator-local one, so `payment_id`,
  `run_id` and `resolves_id` are plain columns.

| Table                                | Kind | Columns (beyond `created_at`)                                                                                               | RLS (runtime)                                                                                                        |
| ------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `billing.ledger_accounts`            | T    | PK `(tenant_id, code, currency)`, `immudb_account_id uuid`                                                                  | read `tenant_id = app.tenant_id() and app.elevated()`; insert `tenant_id = app.tenant_id()`                          |
| `billing.ledger_entry_refs`          | T    | PK `(tenant_id, entry_id uuid)`, `source_key`, `payload_hash`, `immudb_tx_id bigint`, `payment_id`, `kind`, `posted_at`     | read `tenant_id = app.tenant_id() and app.elevated()`; insert `tenant_id = app.tenant_id()`; no update/delete        |
| `billing.ledger_discrepancies`       | T    | PK `(tenant_id, id uuidv7)`, `kind`, `source_key`, `expected jsonb`, `actual jsonb`, `detected_by`, `run_id`, `resolves_id` | read `tenant_id = app.tenant_id() and app.elevated()`; insert `tenant_id = app.tenant_id()`; `REVOKE UPDATE, DELETE` |
| `billing.ledger_reconciliation_runs` | L    | PK `id uuid`, `from_ts`, `to_ts`, `status`, `counts jsonb`, `finished_at`                                                   | none (system only)                                                                                                   |
| `billing.ledger_trusted_state`       | L    | PK `database text`, `tx_id bigint`, `tx_hash bytea`, `verified_at`                                                          | none (system only)                                                                                                   |

Policies call the helpers directly (`app.tenant_id()`, never `(select app.tenant_id())`): Citus rejects subqueries in
policies (sharding design section 7.1).

The checkout idempotency key stays on `billing.payments` (unique `(tenant_id, user_id, idempotency_key)`, B2-6)
under the payments policy of spec section 8.2.

- **New named system methods** (extend spec section 9's list; each in a `*.system-repository.ts`): 8. `stripeEvents.markProcessedAsPlatform` + `outbox.insertAsPlatform` (platform-level webhooks: `payout.*`); 9. `ledgerReconciliation.listSucceededPayments(from, to, cursor)` and `listEntryRefs(from, to, cursor)`
  (cross-tenant reads for R3); 10. `ledgerReconciliation.appendDiscrepancies(rows)`, `enqueueMissingPostings(rows)`
  and `ledgerEntryRefs.recordAsSystem(rows)` (cross-tenant writes, and the consumer's receipts and discrepancies
  for platform-tenant or user-less postings); 11. `ledgerTrustedState.read(database)` / `advance(database, from, to)`
  and `ledgerRuns.start/finish`.

## 6. Placement, config, compose, health, tests

### 6.1 Packages (layering apps → domains → contracts → libs, `scripts/check-boundaries.mjs`)

- **`libs/immudb` (`@platform/immudb`)**, ledger-agnostic (libs name no domain): vendored
  `proto/immudb/schema/schema.proto` (stripped by a committed `scripts/strip-proto.mjs`), generated
  `src/generated/**` (committed, CI drift like contracts: add `--filter @platform/immudb` to root `proto:gen`),
  `ImmudbModule.forRootAsync({ migrations })` (global, token `IMMUDB_CLIENT`), `ImmudbClient` (session pool,
  `readWrite`/`readOnly`/`query`, error mapping), `ImmudbHealthIndicator`, `runImmudbMigrations` +
  `runImmudbMigrationsCli` (versioned `NNN_name.sql`, bookkeeping table `immudb_migrations`, provisioning of the
  database and the INSERT/SELECT-only user via `ChangeSQLPrivileges`), `src/verification/**` (pure proof code),
  `./testing` subpath with a fake client. Dependencies: `@grpc/grpc-js`, `@bufbuild/protobuf`, `@platform/config`.
  Modeled on `libs/cassandra` (`cassandra.module.ts`, `health/`, `migrations/`).
- **`domains/billing`**: `domain/ledger/**` (entry, posting, chart, invariant, ids, hash), `application/ports/
ledger.port.ts`, `application/ledger/posting-rules.ts`, `application/commands/{post-ledger-entry,reconcile-ledger}/`,
  `infrastructure/ledger/immudb-ledger.adapter.ts`, `infrastructure/ledger/migrations/001_ledger.sql`
  (`billingLedgerMigrations = { name: 'billing-ledger', dir }`, passed by apps like
  `notificationsCassandraMigrations`), `infrastructure/scheduling/reconcile-ledger.cron.ts`,
  `infrastructure/persistence/*.system-repository.ts`, `presentation/messaging/ledger-posting.consumer.ts`,
  `src/testing/in-memory-ledger.ts` behind a new `@domain/billing/testing` subpath. A new `domains/ledger` is not
  needed: the ledger's only producer and its posting rules are billing's.
- **Apps**: monolith and billing-service import `ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] })`,
  add `ImmudbHealthIndicator` to `healthContributors` (`apps/billing-service/src/app.module.ts:30`,
  `apps/monolith/src/app.module.ts:61`) and run immudb migrations from `src/migrate.ts`. The gateway does not.

### 6.2 Config

- Platform namespace `immudb` in `libs/config/src/namespaces/immudb.config.ts`, registered in `CONFIG_NAMESPACES` +
  `AllConfig` (`libs/config/src/all-config.ts`, a cross-phase hotspot: serialize the edit): `IMMUDB_ADDRESS`
  (`localhost:3322`), `IMMUDB_DATABASE` (`ledger`), `IMMUDB_USERNAME` (`ledger_app`), `IMMUDB_PASSWORD`,
  `IMMUDB_ADMIN_USERNAME` / `IMMUDB_ADMIN_PASSWORD` (migrations/provisioning only), `IMMUDB_SESSION_POOL_SIZE` (4),
  `IMMUDB_TIMEOUT_MS` (5000), `IMMUDB_KEEPALIVE_INTERVAL_MS` (60000, below the 3-minute inactivity limit),
  `IMMUDB_TLS` (false), `IMMUDB_ALLOW_INSECURE` (false), `IMMUDB_SERVER_SIGNING_PUBLIC_KEY` (base64 PEM, optional),
  `IMMUDB_RUN_MIGRATIONS` (false). Production guards: known local passwords (`immudb`) via
  `addKnownLocalSecretIssue`; plaintext transport refused unless `IMMUDB_ALLOW_INSECURE`.
- Domain namespace `ledger` in `domains/billing/src/infrastructure/ledger/ledger.config.ts`: `LEDGER_ENABLED`
  (false), `LEDGER_RECONCILE_LOOKBACK_HOURS` (72), `LEDGER_VERIFY` (false until R5). `LEDGER_NAMESPACE` is a code
  constant, never env (changing it would re-key every entry).
- Root `.env.example` sections, `apps/{monolith,billing-service}/.env.example`, each app's `test/env-example.spec.ts`
  namespace list, `docs/CONFIGURATION.md` table rows; `node scripts/check-env-example.mjs`.

### 6.3 Compose, health, readiness

- Service `immudb`: `codenotary/immudb:1.11.2`, `IMMUDB_PGSQL_SERVER: "false"` (no cleartext pg-wire),
  `IMMUDB_ADMIN_PASSWORD` from env, `127.0.0.1:${IMMUDB_HOST_PORT:-3322}:3322`, metrics 9497 on the network only
  (Prometheus scrape in the `observability` profile), volume `immudb-data`, anchor `x-env-immudb`, `depends_on` for
  monolith and billing-service. The image is distroless (P0: no shell), so **no exec healthcheck**; readiness is
  `GET /readyz` on 9497 (P0), polled by `scripts/docker/check-infra.sh` from the host and by the app's
  `ImmudbHealthIndicator` (gRPC `Health`). Provisioning runs from the app's migrate step (gRPC; P4 showed pg-wire
  `GRANT` is a no-op).
- Readiness: `/health/ready` includes immudb only when `LEDGER_ENABLED=true`; the webhook path never depends on
  immudb (outbox), so an immudb outage delays postings but never fails a payment.

### 6.4 Tests

- **Unit**: invariant, ids, canonical hash, posting rules per balance-transaction type (Stripe fixtures), tenant
  guards, error mapping table, verification primitives against golden vectors produced once by the Go SDK
  (`libs/immudb/test/vectors/*.json`, generator script committed) plus byte-flip negatives.
- **Shared contract spec**: `describeLedgerContract(makeLedger)` in `domains/billing/src/testing/ledger.contract.test.ts`
  (`.test.ts` is a helper, not collected) run by the fake's spec and by the adapter's int spec: posted → replayed →
  conflict, unbalanced rejected before I/O, concurrent posts of one entry yield one `posted`.
- **Fake**: `InMemoryLedger implements LedgerPort` with the same id, hash, replay/conflict and balance semantics.
- **Int** (`INTEGRATION=1`): `GenericContainer('codenotary/immudb:1.11.2').withEnvironment({ IMMUDB_PGSQL_SERVER:
'false' }).withExposedPorts(3322, 9497).withWaitStrategy(Wait.forHttp('/readyz', 9497))`; covers provisioning,
  privileges (UPDATE denied), every mapped error string, MVCC race, proofs; RLS specs for the new Postgres tables on
  `startTestPostgres({ localExecution: false, initSql })` from `@platform/testing/postgres` (sharding SH-1, Citus
  single node), asserting `pg_dist_partition` kinds (three T, two L) as well.
- **e2e both topologies**: monolith e2e drives a signed webhook → outbox row → relay/consumer (in-process fakes for
  Kafka) → `InMemoryLedger`; gateway e2e asserts the forwarded webhook still answers; billing-service e2e covers the
  gRPC surface. The real cross-process path runs in the compose topology check (E-4).

## 7. Interaction with Citus and PgBouncer (reconciled 2026-11-09)

Written first on assumptions; now aligned with the sharding design
(`docs/superpowers/specs/2026-11-09-sharding-citus-pgbouncer-design.md`, sections 2.3, 4.2, 7.1 and 7.4):

- **Tenant-distributed (T)**, colocated with `app.tenant_colocation`: `billing.payments`, `billing.stripe_events`,
  `billing.outbox`, `billing.ledger_accounts`, `billing.ledger_entry_refs`, `billing.ledger_discrepancies`. Every PK
  and unique leads with `tenant_id`: `stripe_events` PK `(tenant_id, id)`, payments uniques
  `(tenant_id, stripe_checkout_session_id)` and `(tenant_id, user_id, idempotency_key)`. (This "tenant-leading
  unique" is the Stripe checkout-session unique on payments; `identity.sessions` is distributed by `user_id` with PK
  `(user_id, id)` and is not touched by the ledger.)
- **Coordinator-local (L):** `billing.ledger_reconciliation_runs` and `billing.ledger_trusted_state`, touched only by
  the system pool. Not reference tables: no policy helper reads them.
- **Distribution calls.** `payments` and `stripe_events` are distributed by SH-6 (right after B2-6); `outbox` by G-1
  inline; the three T ledger tables by L-10 inline, right after each `CREATE TABLE`.
- The webhook transaction (stripe_events + payment + outbox) touches one tenant, so it stays a single-shard
  transaction, routed by the `tenant_id` predicate taken from the signed metadata. Platform-level events land on the
  `PLATFORM_TENANT_ID` shard (section 5).
- Reconciliation's cross-tenant reads (R3) are multi-shard fan-out queries on the system pool, without row locks,
  acceptable for an hourly job; keyset pagination by `(tenant_id, id)`.
- **Outbox relay:** the program's single active relay (Redis-lock leader, multi-shard poll without row locks, router
  mark-published, at-least-once); see section 3.
- **RLS context:** the consumer's Postgres writes run under the `SET LOCAL app.user_id/app.tenant_id/app.elevated`
  context that the transactional adapter sends on `BEGIN` (sharding design section 7.1; `set_config()` never reaches
  Citus workers). It works behind PgBouncer in transaction mode. PgBouncer changes nothing for immudb (gRPC).

## 8. Proposed tasks and waves

Commit scopes: `immudb` exists as a scope once `libs/immudb/package.json` exists (conventions §2.3); billing work uses
`billing`, compose `docker`, config `config`. Billing Postgres migrations are serialized with B2-6/B3-6/G-1 on one
lane (conventions §3).

| Task | Title                                                                                                                                                                                                                                                                              | Size | Wave | Needs                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------------------------------------ |
| L-1  | `@platform/immudb` package: vendored stripped proto, strip script, buf/ts-proto codegen (`outputServices=grpc-js`), committed `src/generated`, CI drift filter; add `@bufbuild/protobuf` 2.x (imported by the generated `wire` code, not in the root catalog today) to the catalog | M    | 0    | none                                       |
| L-2  | Session pool, `readWrite`/`readOnly`/`query`, keepalive, error mapping, `ImmudbModule`, health indicator, `immudb` config namespace + `.env.example` + docs, Testcontainers int spec                                                                                               | L    | 0    | L-1                                        |
| L-3  | Provisioning (database, INSERT/SELECT user via `ChangeSQLPrivileges`) + versioned `.sql` migrator + CLI                                                                                                                                                                            | M    | 0    | L-2                                        |
| L-4  | Verification primitives port (htree, ahtree, linear, linear-advance, dual proof, Alh, entry digests v0/v1) with Go-generated golden vectors                                                                                                                                        | L    | 0    | L-1                                        |
| L-5  | SQL row verification (`verifyRow`), `verifiedRow`, `verifyConsistency`, state signature check, negative int specs                                                                                                                                                                  | M    | 0    | L-2, L-4                                   |
| L-6  | Compose `immudb` service, `x-env-immudb`, `check-infra.sh` `/readyz`, Prometheus scrape, `docs/DOCKER.md`                                                                                                                                                                          | S    | 0    | L-2                                        |
| L-7  | Stripe fixes without schema: S-1 retrieve bound session, S-3 in-flight 409, S-5 amount/currency verification + metric, S-8 optional `stripePaymentIntentId`, S-10 pinned `apiVersion`                                                                                              | M    | 0    | none (rebase over B2-26 if it lands first) |
| L-8  | Billing ledger model (pure): draft/entry types, chart, invariant, `ledgerEntryId`, `ledgerPayloadHash`, posting rules per balance-transaction type, `LedgerPort`, `InMemoryLedger`, shared contract spec, `@domain/billing/testing` subpath                                        | L    | 0    | none                                       |
| L-9  | `ImmudbLedgerAdapter` + `001_ledger.sql` + contract int spec against immudb                                                                                                                                                                                                        | M    | 0    | L-3, L-8                                   |
| L-10 | Postgres ledger tables + inline `app.distribute_by_tenant` for the three T tables + RLS (custom SQL) + system repositories (section 5); the S-2 `request_hash` fill and compare (column from B2-6)                                                                                 | M    | 1    | B2-6, SH-6, B3-6, B3-10, B3-11, G-1        |
| L-11 | Webhook coverage (refund, dispute, payout, charge events) writing `billing.ledger-posting.v1` outbox rows; platform-level events via system path; topic + `.dlq` in `docker/kafka/topics.txt`; contract in `billing.events.ts`                                                     | L    | 1    | G-1, G-2, L-10                             |
| L-12 | `LedgerPostingConsumer`: principal from envelope (`SystemContext` for platform or user-less messages), Stripe balance-transaction fetch, posting, `ledger_entry_refs`, conflict → discrepancy, metrics; `LEDGER_ENABLED` wiring in monolith + billing-service                      | L    | 2    | G-3, L-9, L-11                             |
| L-13 | Reconciliation cron R1-R4, discrepancy writes, metrics and alert rules                                                                                                                                                                                                             | L    | 2    | L-12, G-4                                  |
| L-14 | Verified reconciliation R5: trusted state, `VerifiableTxById` advance, per-entry `VerifiableSQLGet`                                                                                                                                                                                | M    | 2    | L-5, L-13                                  |
| L-15 | e2e both topologies + billing-service e2e + docs (billing README "Consistency", ARCHITECTURE, SECURITY, TESTING, CONFIGURATION)                                                                                                                                                    | M    | 2    | L-12..L-14                                 |

- **Wave 0 (now, parallel to B2):** L-1 → L-2 → {L-3, L-6}; L-4 → L-5; L-7; L-8 → L-9. Two lanes suffice:
  `immudb` (L-1..L-6, L-9) and `billing-ledger` (L-7, L-8). None touches tenant columns or billing migrations.
- **Wave 1 (after B2-6, SH-6, B3-6, B3-10/11, G-1/G-2):** L-10, L-11 on the billing migration lane (billing
  migration order: B2-6 → SH-6 → B3-5/B3-6 → G-1 → L-10, each the next free `NNNN` in the set at merge time).
- **Wave 2 (after G-3, G-4):** L-12 → L-13 → L-14, L-15.
- **Final squash:** the program's squash task folds the billing Postgres stack into `0000_init` (keeping RLS SQL); the
  immudb `NNN_*.sql` set is squashed the same way into `001_ledger.sql` only if no environment has applied it.

### 8.1 Must land in B2 (B2-6 migration and B2-26 metadata) (ruled 2026-11-09, D5)

Because billing migrations are serialized, B2-6 includes what this design needs on existing tables:

1. `billing.payments.request_hash text` (nullable; S-2) and the tenant-scoped unique
   `(tenant_id, user_id, idempotency_key)`.
2. `billing.stripe_events`: PK `(tenant_id, id)` (Citus) and `user_id uuid` **nullable** (platform-level events such
   as `payout.paid` carry no user; program spec 5.1 now says so).
3. `billing.payment_status` gains `refunded`, `partially_refunded`, `disputed` (S-6) in B2-6 itself.
4. B2-26 puts `{ paymentId, userId, tenantId }` in **both** session metadata and `payment_intent_data.metadata`
   (`stripe.service.ts:38-40` already mirrors them), so charges, refunds and disputes resolve a tenant.
5. B2 reserves `PLATFORM_TENANT_ID` (nil UUID) as never-a-tenant: B2-1 adds
   `CONSTRAINT tenants_id_not_platform CHECK (id <> '00000000-0000-0000-0000-000000000000')` to `identity.tenants`.

## Interface contracts

```ts
// @domain/billing (domain/ledger, application/ports/ledger.port.ts)
export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const LEDGER_NAMESPACE: string; // fixed uuid constant, never env
export type LedgerAccountCode =
  | 'asset:stripe_balance'
  | 'asset:bank'
  | 'revenue:checkout'
  | 'contra_revenue:refunds'
  | 'contra_revenue:disputes'
  | 'expense:stripe_fees'
  | 'expense:dispute_fees'
  | 'equity:adjustments';
export type LedgerEntryKind =
  | 'charge'
  | 'refund'
  | 'refund_failure'
  | 'dispute'
  | 'dispute_reversal'
  | 'payout'
  | 'payout_failure'
  | 'stripe_fee'
  | 'adjustment';
export interface LedgerLine {
  readonly account: LedgerAccountCode;
  readonly accountOwnerTenantId: string; // entry tenant or PLATFORM_TENANT_ID
  readonly currency: string; // lowercase ISO 4217
  readonly debit: bigint; // exactly one of debit/credit > 0n
  readonly credit: bigint;
}
export interface LedgerEntryDraft {
  readonly sourceKey: string; // 'stripe:txn:txn_…'
  readonly tenantId: string;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly stripeObjectId: string | null;
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
  readonly occurredAt: Date;
  readonly lines: readonly LedgerLine[];
}
export type LedgerPostOutcome =
  | {
      readonly status: 'posted';
      readonly entryId: string;
      readonly payloadHash: string;
      readonly immudbTxId: bigint;
    }
  | { readonly status: 'replayed'; readonly entryId: string; readonly payloadHash: string }
  | {
      readonly status: 'conflict';
      readonly entryId: string;
      readonly payloadHash: string;
      readonly existingPayloadHash: string;
    };
export function ledgerEntryId(sourceKey: string): string; // uuidv5(LEDGER_NAMESPACE, sourceKey)
export function ledgerPayloadHash(draft: LedgerEntryDraft): string; // sha256 hex, canonical JSON
export function assertBalanced(draft: LedgerEntryDraft): void; // throws LedgerUnbalancedException
export abstract class LedgerPort {
  abstract post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome>;
  abstract getEntry(tenantId: string, entryId: string): Promise<LedgerEntry | null>;
  abstract balances(tenantId: string, currency?: string): Promise<readonly LedgerBalance[]>;
  abstract findUnbalanced(window: {
    fromUs: bigint;
    toUs: bigint;
  }): Promise<readonly LedgerImbalance[]>;
  abstract totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  >;
  abstract findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]>;
  abstract verifyEntry(
    entryId: string,
    expectedPayloadHash: string,
    trusted: LedgerTrustedState,
  ): Promise<void>;
  abstract advanceTrustedState(trusted: LedgerTrustedState | null): Promise<LedgerTrustedState>;
}
export interface LedgerTrustedState {
  readonly database: string;
  readonly txId: bigint;
  readonly txHash: Uint8Array;
}

// @platform/immudb
export type ImmudbValue = null | string | bigint | boolean | Uint8Array | Date;
export type ImmudbParams = Readonly<Record<string, ImmudbValue>>;
export interface ImmudbTx {
  exec(sql: string, params?: ImmudbParams): Promise<void>;
  query<T extends Record<string, ImmudbValue>>(sql: string, params?: ImmudbParams): Promise<T[]>;
}
export interface ImmudbState {
  readonly database: string;
  readonly txId: bigint;
  readonly txHash: Uint8Array;
  readonly signature: Uint8Array | null;
}
export type ImmudbErrorKind =
  | 'duplicate-key'
  | 'read-conflict'
  | 'read-only'
  | 'access-denied'
  | 'tx-closed'
  | 'unavailable'
  | 'verification-failed';
export class ImmudbError extends Error {
  readonly kind: ImmudbErrorKind;
}
export abstract class ImmudbClient {
  /** Commits when work ran an exec, rolls back otherwise; never rolls back after a failed statement. */
  abstract readWrite<T>(
    work: (tx: ImmudbTx) => Promise<T>,
  ): Promise<{ result: T; txId: bigint | null }>;
  abstract readOnly<T>(
    work: (tx: ImmudbTx) => Promise<T>,
    opts?: { mustIncludeTxId?: bigint },
  ): Promise<T>;
  abstract currentState(): Promise<ImmudbState>;
  abstract verifyConsistency(trusted: ImmudbState, target: ImmudbState): Promise<void>;
  abstract verifiedRow(
    table: string,
    pk: readonly ImmudbValue[],
    trusted: ImmudbState,
  ): Promise<{ row: Record<string, ImmudbValue>; txId: bigint; state: ImmudbState }>;
}
export interface ImmudbMigrationSource {
  readonly name: string;
  readonly dir: string;
}
export class ImmudbModule {
  static forRootAsync(options?: { migrations?: readonly ImmudbMigrationSource[] }): DynamicModule;
}

// Outbox topic billing.ledger-posting.v1 (contract in domains/billing/contracts/src/events/billing.events.ts)
export interface LedgerPostingRequestedPayload {
  source: 'stripe';
  stripeEventId: string;
  stripeEventType: string;
  objectType: 'charge' | 'refund' | 'dispute' | 'payout' | 'balance_transaction';
  objectId: string;
  tenantId: string;
  userId: string | null;
  paymentId: string | null;
  livemode: boolean;
}
```

Postgres tables and immudb tables: sections 2.2 and 5.

## Decisions (ruled 2026-11-09)

The user chose auto-run plans; the controller ruled on every open decision. Each line: ruling, then rationale.

- **D1. Verification timing. Ruled 2026-11-09: build L-4/L-5 in wave 0, switch R5 on in wave 2 (L-14).** Rationale:
  they need nothing from B2/B3, and without them the ledger is only "append-only by server promise".
- **D2. Posting carrier. Ruled 2026-11-09: G-3 relay → Kafka `billing.ledger-posting.v1` → billing consumer.**
  Rationale: keeps Stripe and immudb latency out of the relay's poll loop; the relay is the program's single active
  relay under Citus (section 3).
- **D3. Server state signing. Ruled 2026-11-09: production runs immudb with `--signingKey` and pins the public key
  (`IMMUDB_SERVER_SIGNING_PUBLIC_KEY`), in wave 2.** Rationale: R5 then also detects a server that forges its own
  state; key management lands with R5, when it is first needed.
- **D4. Model scope. Ruled 2026-11-09: the platform sells to tenants; no Stripe Connect.** Rationale: matches the
  current single-account Checkout code; the chart in section 2.3 stands.
- **D5. B2-6 contents. Ruled 2026-11-09: B2-6 carries `request_hash`, the tenant-scoped idempotency unique, nullable
  `stripe_events.user_id` with PK `(tenant_id, id)`, the three new payment statuses and the nil-UUID platform tenant
  (CHECK in B2-1); B2-26 puts `tenantId` in the PaymentIntent metadata** (section 8.1). Rationale: billing
  migrations are serialized, so changing these tables once in B2 avoids a second migration on the same lane.

## 9. Reconciled with the sharding design on 2026-11-09

Reconciled with `docs/superpowers/specs/2026-11-09-sharding-citus-pgbouncer-design.md`. Changes made here:

- Section 7 rewritten from assumptions to the sharding design's table kinds: three tenant ledger tables T,
  `ledger_reconciliation_runs` and `ledger_trusted_state` coordinator-local (no longer "reference or local");
  section 5's table gains a Kind column and drops "all distributed by `tenant_id`".
- No FK from the ledger tables (a distributed table cannot reference a coordinator-local one): `run_id`,
  `resolves_id` and `payment_id` are plain columns. L-10 distributes its three T tables inline and now also needs
  SH-6 and G-1.
- RLS context: `SET LOCAL` (not `set_config`), and policies call `app.x()` without `(select …)`.
- Outbox relay: no `FOR UPDATE SKIP LOCKED` across shards; one active relay (Redis lock), router mark-published,
  at-least-once (section 3). The consumer runs in `SystemContext` for platform or user-less messages, with
  `ledgerEntryRefs.recordAsSystem` added to system method 10.
- `PLATFORM_TENANT_ID`: one shard for all platform rows is accepted; the nil UUID is reserved by a CHECK on
  `identity.tenants.id` and refused by the RLS context builder; only the system pool sees those rows. A tenant-level
  event without tenant metadata ends as a `tenant_unresolved` discrepancy.
- RLS int specs for the new tables use `startTestPostgres({ localExecution: false })` (SH-1).
- Checked, no conflict: env names, compose service names (`immudb` vs `postgres`, `pgbouncer`, `postgres-worker-*`,
  `citus-init`) and config namespaces (`immudb`, `ledger` vs `DATABASE_POOLER` in `database`). Shared files to
  serialize with SH-2/SH-9: `docker-compose.yml`, `scripts/docker/check-infra.sh`, `docs/DOCKER.md`, `.env.example`,
  `docs/CONFIGURATION.md`.

## Appendix: probe evidence

All probes ran on 2026-11-09 against `codenotary/immudb:1.11.2` (linux/arm64, distroless: no shell, entrypoint
`/usr/sbin/immudb`; `/version` reports `1.11.0-bfdce036…`, build `Thu, 03 Sep 2026`). Scripts lived in the session
scratchpad and ran from the repo root with Node 24.4.0 so `postgres`, `@grpc/grpc-js`, `@grpc/proto-loader`
resolve from the repo's `node_modules`. Everything created was named `prog-probe-*` and removed at the end (P8).

**P0 setup.**

```
docker network create prog-probe-net
docker run -d --name prog-probe-immudb --network prog-probe-net \
  -p 127.0.0.1::5432 -p 127.0.0.1::3322 -p 127.0.0.1::9497 codenotary/immudb:1.11.2
# docker run --rm codenotary/immudb:1.11.2 --help (trimmed)
--pgsql-server          enable or disable pgsql server (default true)
--pgsql-server-port int pgsql server port (default 5432)
-p, --port int          port number (default 3322)
--max-session-inactivity-time duration  (default 3m0s)
--max-sessions int      maximum number of simultaneously opened sessions (default 100)
--metrics-server-port int  Prometheus endpoint port (default 9497)
# logs
INFO: pgsql server is running at port 5432
WARNING: pgsql server is running WITHOUT TLS. Client passwords will be transmitted in cleartext. ...
# curl 127.0.0.1:<9497>/readyz -> 200, /livez -> 200, /metrics -> 589 immudb_* series
```

**P1 pg-wire connect** (`postgres({ host, port, user: 'immudb', password: 'immudb', database: 'defaultdb',
prepare: false })`): `PostgresError: column does not exist (typarray)` on the first query. With
`fetch_types: false` added: `SELECT 1 AS one` → `[{"one":"1"}]`.

**P2 pg-wire DML, tx, aggregates, history, concurrency** (trimmed):

```
OK   create table / insert with params
FAIL dup PK insert            key already exists            (e.code undefined, no SQLSTATE)
OK   tx begin (2 inserts)     "committed"
FAIL tx rollback on dup       no ongoing transaction        (original dup error masked; p4 absent afterwards)
FAIL explicit rollback        app abort                     (p5 absent afterwards)
OK   sum group by             [{"account":"cash","currency":"usd","d":"1500","c":"0","n":"2"},{"account":"revenue",...,"c":"500"}]
OK   sum group by having      [{"entry_id":"e1","d":"1000","c":"0"}]
OK   update / delete (as superuser)
OK   history of               SELECT _rev, id, debit FROM (HISTORY OF postings) WHERE id='p1'
                              -> rev 1 debit 1000, rev 2 debit 1, rev 3 debit 1 (delete)
OK   since tx / before tx     SELECT id FROM postings SINCE TX 1 / BEFORE TX 3
OK   uuid/json/int64 insert   INTEGER 9007199254740993 round-trips as "9007199254740993"
     typed read               at: inserted 2026-11-09T00:00:00Z, read 2026-11-08T17:00:00.000Z; ok: inserted true, read false
OK   concurrent same PK       ["rejected:tx read conflict","B"]
OK   concurrent read-check-write same entry  ["r1:saw 0","rejected:tx read conflict: fetching more entries than expected"]
OK   CREATE DATABASE IF NOT EXISTS ledger_test / CREATE USER ledger_app WITH PASSWORD '...' READWRITE
```

**P3 pg-wire manual tx and types** (`sql.reserve()` + `BEGIN`): `["begin","ins m1","dup:key already exists",
"commit:no ongoing transaction","rollback:no ongoing transaction","m1 rows 0","conn usable 1"]`. `BOOLEAN` read
back `false` for a bound `true`, a literal `TRUE` and `'true'`; `TIMESTAMP` bound as `'2026-11-09 00:00:00'` read
back `2026-11-08T10:00:00.000Z` (host offset `+0700`).

**P4 pg-wire privileges** (as `immudb`): `GRANT INSERT ON DATABASE defaultdb TO USER ledger_ins` and
`REVOKE UPDATE, DELETE, DROP, ALTER, CREATE ON DATABASE defaultdb TO USER ledger_app` both returned OK, but
`SHOW GRANTS FOR ledger_app` still listed `SELECT CREATE INSERT UPDATE DELETE DROP ALTER`; a `READ` user got
`access denied: statement requires READWRITE permission` for INSERT. `CREATE TABLE chk (… amt INTEGER NOT NULL
CHECK (amt >= 0) …)` succeeded and `INSERT INTO chk VALUES ('x', -1)` was accepted.

**P5 gRPC codegen.** `curl https://raw.githubusercontent.com/codenotary/immudb/v1.11.2/pkg/api/schema/schema.proto`
(2,024 lines, 74 RPCs, imports `google/api/annotations.proto`, `protoc-gen-swagger/options/annotations.proto`);
stripped the 2 imports and 59 `option (…)` blocks; `buf generate` (buf 1.73.0) with
`protoc-gen-ts_proto` opts `outputServices=grpc-js, importSuffix=.js, esModuleInterop=true, env=node,
forceLong=string, stringEnums=true, useOptionals=messages, fileSuffix=.pb, oneof=unions-value` →
`immudb/schema/schema.pb.ts` 18,424 lines (+ `empty.pb.ts`, `struct.pb.ts`); `tsc -p` extending
`tsconfig.base.json` → exit 0, 0 diagnostics.

**P6 gRPC runtime** (`@grpc/proto-loader` over the stripped proto, `keepCase`, `longs: String`):

```
OK   OpenSession        {"sessionID":"a1PB…","serverUUID":"dboo4os3sf5s73dn31lg"}
OK   CurrentState       {"db":"defaultdb","txId":"32","txHash":"8a83…","signature":null,...}
OK   KeepAlive / NewTx RW {"transactionID":"dboo6cc3sf5s73dn31m0"}
OK   TxSQLExec create / insert with @id @e @a params (x2)
FAIL TxSQLQuery in tx   code 2 "index not found"   (table created in the same tx; DDL must commit first)
OK   Commit             {"header":{"id":"33","prevAlh":"8a83…","nentries":7,"eH":"ea1c…","blTxId":"32","blRoot":"6c07…","version":1},"updatedRows":2}
FAIL TxSQLExec dup      code 2 details "key already exists"
FAIL Rollback after dup code 3 "no transaction found"
OK   VerifiableTxById   {tx: entries[…], dualProof: {…}}
OK   VerifiableSQLGet   {"PKIDs":[1],"ColNamesById":{"1":"id","2":"entry_id","3":"amount"},"sqlEntry":{"tx":"33",...},"verifiableTx":{...}}
OK   ChangeSQLPrivileges {action: REVOKE, username: ledger_app, database: defaultdb, privileges: [UPDATE, DELETE, DROP, ALTER, CREATE]}
OK   SHOW GRANTS FOR ledger_app -> INSERT, SELECT
OK   CloseSession
```

**P7 pg-wire as the revoked user** (`ledger_app`): `insert` OK; `update` → `access denied: statement requires
[UPDATE] privileges`; `delete` → `[DELETE]`; `upsert` → `[INSERT UPDATE]`; `drop` → `[DROP]`; `create` →
`[CREATE]`; `select` OK.

**P8 gRPC posting pattern** (one session; `NewTx` modes; params typed):

```
OK   RW select absent            SELECT id, payload_hash FROM ledger_entries WHERE id = @id  -> []
OK   RW insert ts                occurred_at bound as {ts: "1794182400000000"} (µs, 2026-11-09T00:00:00Z)
OK   RW select own write         [["E1","abc","1794182400000000"]]   (read-your-writes inside the tx; no tz shift)
OK   RW commit                   header.id 36
OK   replay select present       [["abc"]]  -> compare payload hash, Rollback (no writes) OK
OK   RO select (snapshotMustIncludeTxID = 36)  [["E1","1794182400000000"]]
FAIL RO insert refused           code 2 "read-only transaction"; the following Rollback -> code 3 "no transaction found"
OK   race (2 RW txs: select E3, insert E3, commit)  ["rejected: 2 tx read conflict","committed tx 37"]
# docker run --rm codenotary/immudb:1.11.2 --help (trimmed)
--signingKey string   signature private key path. If a valid one is provided, it enables the cryptographic signature of the root
--max-active-databases int   the maximum number of databases that can be active simultaneously (default 100)
--synced              synced mode prevents data lost under unexpected crashes but affects performance (default true)
--replication-sync-enabled / --replication-sync-acks int   synchronous replication
```

**P9 cleanup.**

```
docker rm -f prog-probe-immudb && docker network rm prog-probe-net
docker ps -a --filter name=prog-probe- --format '{{.Names}}'   -> prog-probe-worker, prog-probe-coord
docker network ls --filter name=prog-probe-                    -> prog-probe-citus-net
```

The remaining `prog-probe-*` objects belong to the parallel Citus lane (design:sharding) and were left untouched;
everything this lane created is gone.

**A1. Rules that bind the adapter (from P2-P8).**

- The `BOOLEAN`/`TIMESTAMP` oddities are postgres.js decoding immudb's text encoding (its bool parser expects `t`,
  timestamps without zone are parsed as host-local time); the stored values are right (`HISTORY OF`, P2) and gRPC
  round-trips a µs `ts` exactly (P8). The ledger stores times as `INTEGER` epoch microseconds anyway.
- **Any failed statement ends the server tx** (`no transaction found` / `no ongoing transaction`). The client must
  not call `Rollback` after a failed statement, and retries open a new `NewTx`. Over gRPC the original error
  survives; inside postgres.js `sql.begin` it is masked.
- Errors carry no codes: the adapter maps strings (`key already exists`, `tx read conflict…`,
  `read-only transaction`, `access denied: statement requires […]`, `no transaction found`). Pin them to the image
  tag and cover every string in the int spec.
- **Privilege changes work only over gRPC** (`ChangeSQLPrivileges`); pg-wire `GRANT`/`REVOKE` return OK and do
  nothing. Provisioning (compose init job, Testcontainers setup) therefore uses gRPC too.
- `CHECK` is accepted but not enforced; read-check-insert in one `ReadWrite` tx is safe because MVCC rejects the
  loser of a race with `tx read conflict` (P2, P8).
