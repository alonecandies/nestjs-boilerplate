import { EnvValidationError } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { staffSwitchInConfig } from './staff-switch-in.config.js';

describe('staffSwitchIn config namespace', () => {
  it('defaults to 15 minutes', () => {
    expect(staffSwitchInConfig.parse({})).toEqual({ ttlSec: 900 });
    expect(staffSwitchInConfig.KEY).toBe('CONFIGURATION(staffSwitchIn)');
  });

  it.each(['59', '3601', 'soon', '0'])('rejects STAFF_SWITCH_IN_TTL_SEC=%s (60..3600)', (value) => {
    expect(() => staffSwitchInConfig.parse({ STAFF_SWITCH_IN_TTL_SEC: value })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts the bounds', () => {
    expect(staffSwitchInConfig.parse({ STAFF_SWITCH_IN_TTL_SEC: '60' }).ttlSec).toBe(60);
    expect(staffSwitchInConfig.parse({ STAFF_SWITCH_IN_TTL_SEC: '3600' }).ttlSec).toBe(3600);
  });
});
