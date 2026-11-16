import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

/** Lifetime of a staff switch-in access token (spec §5.2). Loaded by IdentityCoreModule only. */
export const staffSwitchInEnvSchema = z
  .object({
    STAFF_SWITCH_IN_TTL_SEC: zInt(900, { min: 60, max: 3_600 }),
  })
  .transform((env) => ({ ttlSec: env.STAFF_SWITCH_IN_TTL_SEC }));

export const staffSwitchInConfig = defineConfigNamespace('staffSwitchIn', staffSwitchInEnvSchema);
export type StaffSwitchInConfig = ConfigType<typeof staffSwitchInConfig>;
