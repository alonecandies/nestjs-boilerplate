-- Hand-edited to IF NOT EXISTS: the drizzle migrator creates this schema first, for identity.__drizzle_migrations.
CREATE SCHEMA IF NOT EXISTS "identity";
--> statement-breakpoint
CREATE TYPE "identity"."user_role" AS ENUM('admin', 'moderator', 'user');--> statement-breakpoint
CREATE TABLE "identity"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"roles" "identity"."user_role"[] DEFAULT ARRAY['user']::identity.user_role[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "identity"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "identity"."sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "users_search_trgm_idx" ON "identity"."users" USING gin ("email" gin_trgm_ops,"display_name" gin_trgm_ops);