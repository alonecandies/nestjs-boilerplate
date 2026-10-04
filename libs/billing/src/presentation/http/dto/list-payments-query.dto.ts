import { MAX_CURSOR_LENGTH } from '@app/common';
import { z } from 'zod';
import { BILLING_LIMITS } from '../../../billing.constants.js';

/**
 * `GET /v1/billing/payments` query. `all=true` lists every user's payments and requires
 * `billing:read-all` (checked in the controller: the permission depends on the query value).
 * No `.meta({ id })` on query schemas: Swagger must expand them into individual parameters.
 */
export const listPaymentsQuerySchema = z.object({
  all: z
    .stringbool({ truthy: ['true', '1'], falsy: ['false', '0'] })
    .default(false)
    .describe("Every user's payments (requires billing:read-all)"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(BILLING_LIMITS.MAX_PAGE_SIZE)
    .default(BILLING_LIMITS.DEFAULT_PAGE_SIZE),
  cursor: z
    .string()
    .min(1)
    .max(MAX_CURSOR_LENGTH)
    .optional()
    .describe('`nextCursor` of the previous page'),
});

export type ListPaymentsQueryDto = z.infer<typeof listPaymentsQuerySchema>;
