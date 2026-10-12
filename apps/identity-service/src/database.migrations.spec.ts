import { describe, expect, it } from 'vitest';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

describe('DATABASE_MIGRATIONS (identity-service)', () => {
  it("owns the identity schema only: billing's tables are never created here", () => {
    expect(DATABASE_MIGRATIONS.map((set) => set.migrationsSchema)).toEqual(['identity']);
  });
});
