/**
 * Canonical (lower-case) HTTP header names used across the platform. Node/Fastify lower-case
 * incoming header names, so always read `req.headers[HTTP_HEADERS.X]` with these values.
 */
export const HTTP_HEADERS = {
  REQUEST_ID: 'x-request-id',
  CORRELATION_ID: 'x-correlation-id',
  IDEMPOTENCY_KEY: 'idempotency-key',
  STRIPE_SIGNATURE: 'stripe-signature',
  RETRY_AFTER: 'retry-after',
} as const;

export type HttpHeaderName = (typeof HTTP_HEADERS)[keyof typeof HTTP_HEADERS];

/** RFC 9457 media type. `charset` is explicit so raw (non-Fastify) writes match Fastify's output. */
export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json; charset=utf-8';
