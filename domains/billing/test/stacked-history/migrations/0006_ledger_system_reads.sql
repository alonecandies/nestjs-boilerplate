-- Custom (drizzle-kit generate --custom --name ledger_system_reads): outbox plan Task 11, program
-- spec §9 item 9. Reconciliation R3 reads the paid payments of every tenant through the pinned
-- system method ledgerReconciliation.listSucceededPayments (app_system, BYPASSRLS, inside
-- SystemContext), so app_system gets SELECT on billing.payments: no INSERT, UPDATE or DELETE, and
-- no policy (BYPASSRLS skips them; the runtime role's policies are unchanged).
GRANT SELECT ON TABLE billing.payments TO app_system;
