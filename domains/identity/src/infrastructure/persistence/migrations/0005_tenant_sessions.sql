-- Hand-added: sessions are disposable and tenant_id cannot be backfilled; everyone logs in again.
DELETE FROM "identity"."sessions";--> statement-breakpoint
DROP INDEX "identity"."sessions_user_id_idx";--> statement-breakpoint
-- Hand-written: drizzle-kit cannot name a column-level primary key (Postgres default name).
ALTER TABLE "identity"."sessions" DROP CONSTRAINT "sessions_pkey";--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_id_pk" PRIMARY KEY("user_id","id");--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE cascade ON UPDATE no action;
