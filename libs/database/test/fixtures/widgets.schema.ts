import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/*
 * Fixture schema for the integration test. Its migrations in ./migrations were generated with the
 * real drizzle-kit (see the README) so the test exercises genuine drizzle-kit output:
 *   0000 creates the table, 0001 adds `sku` (unique) — two entries prove "applied" counting.
 * Only drizzle-orm imports, like every domain `*.schema.ts` (drizzle-kit loads it with its own loader).
 */
export const widgets = pgTable(
  'widgets',
  {
    // PG18 native uuidv7() as the DB default; app-side $defaultFn keeps ids known pre-insert.
    id: uuid().primaryKey().default(sql`uuidv7()`),
    ownerId: uuid().notNull(),
    name: text().notNull(),
    quantity: integer().notNull().default(0),
    sku: text().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('widgets_owner_id_id_idx').on(t.ownerId, t.id)],
);

export type Widget = typeof widgets.$inferSelect;
export type NewWidget = typeof widgets.$inferInsert;
