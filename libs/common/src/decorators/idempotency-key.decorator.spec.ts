import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_KEY_FORMAT,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from '../constants/idempotency-key.constants.js';
import { IdempotencyKey, idempotencyKeySchema } from './idempotency-key.decorator.js';

type ParamFactory = (data: unknown, context: ExecutionContext) => unknown;

class Controller {
  create(@IdempotencyKey() _key: string | undefined): void {
    // handler stub
  }
}

const httpContext = (headers: Record<string, string | string[]>): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

/** Runs the factory Nest stored for the `@IdempotencyKey()` parameter. */
function resolveKey(headers: Record<string, string | string[]>): unknown {
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Controller, 'create') as Record<
    string,
    { factory: ParamFactory; data: unknown }
  >;
  const [param] = Object.values(metadata);
  if (!param) throw new Error('no param metadata');
  return param.factory(param.data, httpContext(headers));
}

describe('Idempotency-Key contract', () => {
  it('is 8 to 255 characters of [A-Za-z0-9._:-]', () => {
    expect([IDEMPOTENCY_KEY_MIN_LENGTH, IDEMPOTENCY_KEY_MAX_LENGTH]).toEqual([8, 255]);
    expect(IDEMPOTENCY_KEY_FORMAT).toBe('8-255 chars of [A-Za-z0-9._:-]');
    for (const key of ['order-42:attempt-1', '0199a1b2-0000-7000-8000-000000000001', 'a.b_c:d-e']) {
      expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
      expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
    }
    for (const key of ['short', 'has spaces in it', 'x'.repeat(256), 'bad key!', 'émoji-key-1']) {
      expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
    }
    expect(idempotencyKeySchema.safeParse('x'.repeat(8)).success).toBe(true);
    expect(idempotencyKeySchema.safeParse('x'.repeat(255)).success).toBe(true);
  });
});

describe('@IdempotencyKey()', () => {
  it('returns the valid header, or undefined when it is absent or empty', () => {
    expect(resolveKey({ 'idempotency-key': 'order-42:attempt-1' })).toBe('order-42:attempt-1');
    expect(resolveKey({})).toBeUndefined();
    expect(resolveKey({ 'idempotency-key': '' })).toBeUndefined();
  });

  it('takes the first value of a repeated header', () => {
    expect(resolveKey({ 'idempotency-key': ['first-key-0001', 'second-key-0002'] })).toBe(
      'first-key-0001',
    );
  });

  it.each(['short', 'has spaces in it', 'x'.repeat(256)])(
    '400 with the validation pipes body for an invalid key %#',
    (key) => {
      let thrown: unknown;
      try {
        resolveKey({ 'idempotency-key': key });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
      const response = (thrown as BadRequestException).getResponse() as {
        message: string;
        errors: { path: string; message: string }[];
      };
      expect(response.message).toBe('Request validation failed');
      expect(response.errors.length).toBeGreaterThan(0);
      for (const issue of response.errors) {
        expect(issue.path).toBe('headers.idempotency-key');
        expect(issue.message).toEqual(expect.any(String));
      }
    },
  );
});
