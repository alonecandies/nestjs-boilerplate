import { describe, expect, it } from 'vitest';
import { DATABASE_MIGRATIONS } from './database.migrations.js';

describe('DATABASE_MIGRATIONS (monolith)', () => {
  it('owns identity, billing, then ai; @platform/database adds the platform set first', () => {
    expect(DATABASE_MIGRATIONS.map((set) => set.migrationsSchema)).toEqual([
      'identity',
      'billing',
      'ai',
    ]);
  });
});
