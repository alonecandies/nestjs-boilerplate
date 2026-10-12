import { describe, expect, it } from 'vitest';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

describe('DATABASE_MIGRATIONS (billing-service)', () => {
  it("owns the billing schema only: identity's tables are never created here", () => {
    expect(DATABASE_MIGRATIONS.map((set) => set.migrationsSchema)).toEqual(['billing']);
  });
});
