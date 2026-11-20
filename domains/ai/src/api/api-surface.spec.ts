import { describe, expect, it } from 'vitest';
import * as root from '../index.js';
import * as api from './index.js';

const API_VALUES = [
  'AI_LIMITS',
  'AI_MESSAGE_STREAM_TRIGGER',
  'AI_RATE_LIMITS',
  'AI_RBAC',
  'AI_SSE_EVENTS',
  'AiApiModule',
  'AiChatErrorCode',
  'AiPermission',
  'AiPort',
  'MESSAGE_ROLES',
  'MESSAGE_STATUSES',
  'SSE_CONTENT_TYPE',
  'USAGE_OUTCOMES',
  'aiMessageStreamTrigger',
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
      'AiToolSources',
      'AiChatTools',
    ]) {
      expect(root).toHaveProperty(name);
      expect(api).not.toHaveProperty(name);
    }
  });
});
