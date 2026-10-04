-- Runs ONCE, on an empty data directory only (docker-entrypoint-initdb.d semantics).
-- Schema objects are NOT created here: the apps own them through Drizzle migrations
-- (@app/database, advisory-locked; DATABASE_RUN_MIGRATIONS=true in compose).

-- Query statistics (needs shared_preload_libraries=pg_stat_statements, set in docker-compose.yml).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- Trigram GIN indexes for the identity user search (ILIKE '%q%'); see identity.schema.ts.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- PG18 ships uuidv7() natively (the migrations use it as the id default): fail init loudly otherwise.
SELECT uuidv7() AS pg18_native_uuidv7;
