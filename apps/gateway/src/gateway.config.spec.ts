import { EnvValidationError } from '@app/config';
import { describe, expect, it } from 'vitest';
import { GATEWAY_KAFKA_GROUP_ID } from './app.constants.js';
import { gatewayConfig } from './gateway.config.js';

describe('gatewayConfig', () => {
  it('defaults the push-consumer group to the fixed blueprint group, not SERVICE_NAME', () => {
    expect(gatewayConfig.parse({ SERVICE_NAME: 'gateway' })).toEqual({
      kafkaGroupId: GATEWAY_KAFKA_GROUP_ID,
    });
    expect(GATEWAY_KAFKA_GROUP_ID).toBe('gateway-push');
  });

  it('honours an explicit KAFKA_GROUP_ID', () => {
    expect(gatewayConfig.parse({ KAFKA_GROUP_ID: 'gateway-push-eu' }).kafkaGroupId).toBe(
      'gateway-push-eu',
    );
  });

  it('rejects an invalid group id with an error naming the variable', () => {
    expect(() => gatewayConfig.parse({ KAFKA_GROUP_ID: 'no spaces allowed' })).toThrow(
      EnvValidationError,
    );
    expect(() => gatewayConfig.parse({ KAFKA_GROUP_ID: 'no spaces allowed' })).toThrow(
      /KAFKA_GROUP_ID/,
    );
  });
});
