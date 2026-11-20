-- Hand-edited to IF NOT EXISTS: the drizzle migrator creates this schema first, for billing.__drizzle_migrations.
CREATE SCHEMA IF NOT EXISTS "billing";
--> statement-breakpoint
CREATE TYPE "billing"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "billing"."payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"price_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"amount_total" bigint,
	"currency" text,
	"status" "billing"."payment_status" DEFAULT 'pending' NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_payment_intent_id" text,
	"idempotency_key" text,
	"paid_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id")
);
--> statement-breakpoint
CREATE TABLE "billing"."stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "payments_user_id_id_idx" ON "billing"."payments" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_user_id_idempotency_key_uq" ON "billing"."payments" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stripe_events_processed_at_idx" ON "billing"."stripe_events" USING btree ("processed_at");