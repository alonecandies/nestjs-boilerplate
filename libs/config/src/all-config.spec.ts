import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { errorOf } from '../test/error-of.js';
import { CONFIG_NAMESPACES, validateAllEnv } from './all-config.js';
import { defineConfigNamespace } from './define-config-namespace.js';
import { zInt } from './env/env.helpers.js';

/** A namespace declared the way a domain declares its own (test-local: platform specs name no domain). */
const ordersConfig = defineConfigNamespace(
  'orders',
  z
    .object({ ORDERS_PAGE_SIZE: zInt(20, { min: 1, max: 100 }) })
    .transform((env) => ({ pageSize: env.ORDERS_PAGE_SIZE })),
);

describe('CONFIG_NAMESPACES', () => {
  it('registers the platform namespaces only (domains pass their own to validateAllEnv)', () => {
    expect(Object.keys(CONFIG_NAMESPACES)).toEqual([
      'app',
      'observability',
      'database',
      'cassandra',
      'immudb',
      'redis',
      'kafka',
      'outbox',
      'grpc',
      'auth',
      'throttle',
      'cache',
      'graphql',
      'mail',
      'storage',
      'ai',
    ]);
  });
});

describe('validateAllEnv with domain namespaces', () => {
  it('parses each domain namespace passed in, keyed and typed by its name', () => {
    const config = validateAllEnv({ ORDERS_PAGE_SIZE: '50' }, [ordersConfig]);

    expect(config.orders).toEqual({ pageSize: 50 });
    expect(config.app.port).toBe(3000);
    expectTypeOf(config.orders).toEqualTypeOf<{ pageSize: number }>();
  });

  it('reports platform and domain failures in one error', () => {
    const error = errorOf(() =>
      validateAllEnv({ PORT: 'x', ORDERS_PAGE_SIZE: '0' }, [ordersConfig]),
    );

    expect(error.namespace).toBe('*');
    expect(error.message).toContain('→ at app.PORT');
    expect(error.message).toContain('→ at orders.ORDERS_PAGE_SIZE');
  });

  it('refuses two namespaces with the same name', () => {
    expect(() => validateAllEnv({}, [ordersConfig, ordersConfig])).toThrow(
      'Config namespace "orders" is registered twice',
    );
    const shadow = defineConfigNamespace('mail', z.object({}));
    expect(() => validateAllEnv({}, [shadow])).toThrow(
      'Config namespace "mail" is registered twice',
    );
  });
});
