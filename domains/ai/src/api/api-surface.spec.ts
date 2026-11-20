import { describe, expect, it } from 'vitest';
import * as root from '../index.js';
import * as api from './index.js';

const API_VALUES = ['MESSAGE_ROLES', 'MESSAGE_STATUSES', 'USAGE_OUTCOMES'];

describe('@domain/ai entry points', () => {
  it('./api exports exactly the edge surface', () => {
    expect(Object.keys(api).sort()).toEqual([...API_VALUES].sort());
  });

  it('the root entry re-exports ./api and keeps persistence', () => {
    for (const name of API_VALUES) {
      expect(root).toHaveProperty(name, (api as Record<string, unknown>)[name]);
    }
    for (const name of ['aiSchema', 'aiMigrations', 'DrizzleConversationsRepository']) {
      expect(root).toHaveProperty(name);
      expect(api).not.toHaveProperty(name);
    }
  });
});
