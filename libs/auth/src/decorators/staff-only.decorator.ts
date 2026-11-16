import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { STAFF_ONLY_KEY } from '../auth.constants.js';
import { StaffOnlyGuard } from '../guards/staff-only.guard.js';

/**
 * Only a platform-staff switch-in token may call the route (403 `STAFF_ONLY`). Runs after the
 * global guards (authentication first). Class or method.
 */
export function StaffOnly(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(STAFF_ONLY_KEY, true), UseGuards(StaffOnlyGuard));
}
