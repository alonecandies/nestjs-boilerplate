-- Billing set, 0008 (ledger refund-accounting fix G3): when reconciliation R5 read the immudb
-- state it stored as trusted. The next run verifies the refs of txs that state includes but
-- recorded since then (no fixed overlap). ledger_trusted_state is a Citus local table; rows from
-- before 0008 have no read time and the next run re-verifies its whole window once.
ALTER TABLE "billing"."ledger_trusted_state" ADD COLUMN "read_at" timestamp (3) with time zone;