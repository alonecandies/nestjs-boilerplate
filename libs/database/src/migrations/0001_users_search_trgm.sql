-- Hand-added: drizzle-kit does not emit extensions. pg_trgm is trusted (PG13+): the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "users_search_trgm_idx" ON "users" USING gin ("email" gin_trgm_ops,"display_name" gin_trgm_ops);