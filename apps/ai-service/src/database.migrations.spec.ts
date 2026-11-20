import { describe, expect, it } from 'vitest';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

describe('DATABASE_MIGRATIONS (ai-service)', () => {
  it("owns the ai schema only: identity's and billing's tables are never created here", () => {
    expect(DATABASE_MIGRATIONS.map((set) => set.migrationsSchema)).toEqual(['ai']);
  });
});
