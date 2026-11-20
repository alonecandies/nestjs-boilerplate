ALTER TYPE "billing"."payment_status" ADD VALUE 'refunded';--> statement-breakpoint
ALTER TYPE "billing"."payment_status" ADD VALUE 'partially_refunded';--> statement-breakpoint
ALTER TYPE "billing"."payment_status" ADD VALUE 'disputed';--> statement-breakpoint
ALTER TABLE "billing"."payments" DROP CONSTRAINT "payments_stripe_checkout_session_id_unique";--> statement-breakpoint
DROP INDEX "billing"."payments_user_id_id_idx";--> statement-breakpoint
DROP INDEX "billing"."payments_user_id_idempotency_key_uq";--> statement-breakpoint
ALTER TABLE "billing"."payments" DROP CONSTRAINT "payments_pkey";--> statement-breakpoint
ALTER TABLE "billing"."stripe_events" DROP CONSTRAINT "stripe_events_pkey";--> statement-breakpoint
-- Hand-edited: rows that predate tenancy belong to the platform tenant (nil UUID), then no default.
ALTER TABLE "billing"."payments" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "billing"."payments" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "billing"."payments" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "billing"."stripe_events" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "billing"."stripe_events" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "billing"."stripe_events" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "billing"."payments" ADD CONSTRAINT "payments_tenant_id_id_pk" PRIMARY KEY("tenant_id","id");--> statement-breakpoint
ALTER TABLE "billing"."stripe_events" ADD CONSTRAINT "stripe_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id");--> statement-breakpoint
CREATE INDEX "payments_tenant_id_user_id_id_idx" ON "billing"."payments" USING btree ("tenant_id","user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_id_stripe_checkout_session_id_uq" ON "billing"."payments" USING btree ("tenant_id","stripe_checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_id_user_id_idempotency_key_uq" ON "billing"."payments" USING btree ("tenant_id","user_id","idempotency_key");
