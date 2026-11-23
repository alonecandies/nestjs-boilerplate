-- Billing set, 0001 (audit fixes OPS-1): billing.ledger_reanchors, the audit trail of the one
-- supported way to replace the trusted immudb state after a restore (the ledger-reanchor CLI,
-- system method ledgerTrustedState.reanchor). Coordinator-local like ledger_trusted_state (no
-- distribution call), forced RLS with no policy, and append-only for the system role: INSERT and
-- SELECT to app_system only, nothing to app_runtime. One statement per breakpoint.
CREATE TABLE "billing"."ledger_reanchors" (
	"id" uuid NOT NULL,
	"database" text NOT NULL,
	"replaced_tx_id" bigint NOT NULL,
	"replaced_tx_hash" "bytea" NOT NULL,
	"new_tx_id" bigint NOT NULL,
	"new_tx_hash" "bytea" NOT NULL,
	"lost_from" timestamp (3) with time zone NOT NULL,
	"operator" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_reanchors_id_pk" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE INDEX "ledger_reanchors_database_created_at_idx" ON "billing"."ledger_reanchors" USING btree ("database","created_at");--> statement-breakpoint
ALTER TABLE billing.ledger_reanchors ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing.ledger_reanchors FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE billing.ledger_reanchors TO app_system;
