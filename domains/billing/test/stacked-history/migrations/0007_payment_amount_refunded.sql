-- Billing set, 0007 (outbox + ledger final review F2/F3): what Stripe reports refunded on a
-- payment's charge, net of failed refunds, in minor units. charge.refunded sets it, refund.failed
-- takes the failed refund off, and the payment's status after a refund failure or a won dispute is
-- recomputed from it. Rows from before 0007 start at 0. Adding a column with a constant default to
-- a distributed table is propagated to every shard by Citus; policies and grants are table-level.
ALTER TABLE "billing"."payments" ADD COLUMN "amount_refunded" bigint DEFAULT 0 NOT NULL;
