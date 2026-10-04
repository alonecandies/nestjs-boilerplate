import { EnvValidationError } from '@app/config';
import { describe, expect, it } from 'vitest';
import { MONOLITH_KAFKA_GROUP_ID } from './app.constants.js';
import { monolithConfig } from './monolith.config.js';

describe('monolithConfig', () => {
  it('defaults the consumer group to the fixed blueprint group, not SERVICE_NAME', () => {
    expect(monolithConfig.parse({ SERVICE_NAME: 'something-else' })).toEqual({
      kafkaGroupId: MONOLITH_KAFKA_GROUP_ID,
    });
  });

  it('honours an explicit KAFKA_GROUP_ID (blank = unset)', () => {
    expect(monolithConfig.parse({ KAFKA_GROUP_ID: 'monolith-blue' }).kafkaGroupId).toBe(
      'monolith-blue',
    );
    expect(monolithConfig.parse({ KAFKA_GROUP_ID: '  ' }).kafkaGroupId).toBe('monolith');
  });

  it('rejects an invalid group id with an error naming the variable', () => {
    expect(() => monolithConfig.parse({ KAFKA_GROUP_ID: 'bad group/id' })).toThrow(
      EnvValidationError,
    );
    expect(() => monolithConfig.parse({ KAFKA_GROUP_ID: 'bad group/id' })).toThrow(
      /KAFKA_GROUP_ID/,
    );
  });
});
