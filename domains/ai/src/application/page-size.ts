import { clamp, isInteger } from 'lodash-es';
import { AI_LIMITS } from '../ai.constants.js';

/** A listing's page size: absent, 0 or invalid → default; otherwise capped at the maximum. */
export function pageSize(requested: number | undefined): number {
  const value = requested ?? 0;
  return isInteger(value) && value > 0
    ? clamp(value, 1, AI_LIMITS.MAX_PAGE_SIZE)
    : AI_LIMITS.DEFAULT_PAGE_SIZE;
}
