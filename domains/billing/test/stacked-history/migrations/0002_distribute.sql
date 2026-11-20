-- Custom (drizzle-kit generate --custom --name distribute): sharding design SH-6, section 4.2.
-- Both billing tables are tenant-distributed, colocated with app.tenant_colocation (and so with
-- identity's tenant tables). The platform helpers are no-ops without Citus and on a re-run.
-- Tables created after this file distribute inline, right after their CREATE TABLE.
SELECT app.distribute_by_tenant('billing.payments');--> statement-breakpoint
SELECT app.distribute_by_tenant('billing.stripe_events');
