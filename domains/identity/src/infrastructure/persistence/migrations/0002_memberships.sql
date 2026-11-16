CREATE TYPE "identity"."tenant_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "identity"."memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"roles" "identity"."tenant_role"[] NOT NULL,
	"last_active_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "memberships_roles_not_empty" CHECK (cardinality("roles") > 0)
);
--> statement-breakpoint
ALTER TABLE "identity"."memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_id_last_active_at_idx" ON "identity"."memberships" USING btree ("user_id","last_active_at" DESC NULLS LAST);