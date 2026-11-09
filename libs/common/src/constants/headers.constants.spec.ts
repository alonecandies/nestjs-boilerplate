import { describe, expect, it } from 'vitest';
import { HTTP_HEADERS } from './headers.constants.js';

describe('HTTP_HEADERS', () => {
  it('names platform-wide headers only (a domain keeps its own)', () => {
    expect(HTTP_HEADERS).not.toHaveProperty('STRIPE_SIGNATURE'); // vocabulary-allow: asserts libs hold no stripe header
    expect(HTTP_HEADERS).toMatchObject({
      REQUEST_ID: 'x-request-id',
      CORRELATION_ID: 'x-correlation-id',
      IDEMPOTENCY_KEY: 'idempotency-key',
      RETRY_AFTER: 'retry-after',
    });
  });
});
