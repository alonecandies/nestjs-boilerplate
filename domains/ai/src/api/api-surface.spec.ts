import { describe, expect, it } from 'vitest';
import * as root from '../index.js';
import * as api from './index.js';

const API_VALUES = [
  'AI_LIMITS',
  'AI_RATE_LIMITS',
  'AI_RBAC',
  'AiApiModule',
  'AiChatErrorCode',
  'AiPermission',
  'AiPort',
  'MESSAGE_ROLES',
  'MESSAGE_STATUSES',
  'USAGE_OUTCOMES',
  'aiRateLimitConfig',
];

describe('@domain/ai entry points', () => {
  it('./api exports exactly the edge surface', () => {
    expect(Object.keys(api).sort()).toEqual([...API_VALUES].sort());
  });

  it('the root entry re-exports ./api and keeps persistence', () => {
    for (const name of API_VALUES) {
      expect(root).toHaveProperty(name, (api as Record<string, unknown>)[name]);
    }
    for (const name of [
      'aiSchema',
      'aiMigrations',
      'DrizzleConversationsRepository',
      'AiCoreModule',
    ]) {
      expect(root).toHaveProperty(name);
      expect(api).not.toHaveProperty(name);
    }
  });
});
