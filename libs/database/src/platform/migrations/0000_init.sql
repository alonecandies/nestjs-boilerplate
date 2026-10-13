-- @platform/database platform set: applied before every domain set, under the same advisory lock.
-- Hand-written: drizzle-kit has no schema to diff here. Never edit an applied file; add the next one
-- and its meta/_journal.json entry (libs/database/README.md, "Platform migration set").
-- The migrator already created "app" for app.__drizzle_migrations: IF NOT EXISTS keeps this valid alone.
CREATE SCHEMA IF NOT EXISTS "app";--> statement-breakpoint
-- pg_trgm backs identity's users_search_trgm_idx (drizzle-kit does not emit extensions). Trusted
-- since PG13, so the database owner may create it. Pinned to public: drizzle-kit writes the opclass
-- unqualified (gin_trgm_ops), and public is on the default search_path of every role.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
