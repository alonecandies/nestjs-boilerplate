import { describe, expect, expectTypeOf, it } from 'vitest';
import { errorOf } from '../../test/error-of.js';
import { ALL_CONFIG_NAMESPACES, CONFIG_NAMESPACES, validateAllEnv } from '../all-config.js';
import { EnvValidationError } from '../env/parse-env.js';
import { type AppConfig, appConfig } from './app.config.js';
import { type AuthConfig, authConfig, DEV_JWT_ACCESS_SECRET } from './auth.config.js';
import { cacheConfig } from './cache.config.js';
import { cassandraConfig } from './cassandra.config.js';
import { databaseConfig } from './database.config.js';
import { graphqlConfig } from './graphql.config.js';
import { grpcConfig } from './grpc.config.js';
import { kafkaConfig } from './kafka.config.js';
import { mailConfig } from './mail.config.js';
import { observabilityConfig } from './observability.config.js';
import { redisConfig } from './redis.config.js';
import { storageConfig } from './storage.config.js';
import { throttleConfig } from './throttle.config.js';

describe('config namespaces — defaults work with an EMPTY environment (local docker infra)', () => {
  it('every namespace parses {}', () => {
    expect(() => validateAllEnv({})).not.toThrow();
    expect(ALL_CONFIG_NAMESPACES).toHaveLength(Object.keys(CONFIG_NAMESPACES).length);
  });

  it('holds no domain namespace (domains register their own)', () => {
    expect(CONFIG_NAMESPACES).not.toHaveProperty('stripe'); // vocabulary-allow: asserts libs hold no stripe code
  });

  it('app', () => {
    expect(appConfig.parse({})).toEqual({
      nodeEnv: 'development',
      isProduction: false,
      isTest: false,
      serviceName: 'app',
      host: '0.0.0.0',
      port: 3000,
      corsOrigins: ['http://localhost:3000', 'http://localhost:5173'],
      trustProxy: false,
      bodyLimitBytes: 1_048_576,
      keepAliveTimeoutMs: 72_000,
      requestTimeoutMs: 30_000,
      handlerTimeoutMs: 30_000,
      clusterWorkers: 1,
      shutdownTimeoutMs: 10_000,
      maintenanceMode: false,
      docsEnabled: true,
    } satisfies AppConfig);
  });

  it('observability', () => {
    expect(observabilityConfig.parse({})).toEqual({
      serviceName: 'app',
      logLevel: 'info',
      logPretty: true,
      metricsEnabled: true,
      metricsPort: 9464,
      metricsBearerToken: undefined,
      observe: { enabled: false, appKey: undefined, appSecret: undefined, serviceId: 'app' },
    });
  });

  it('infrastructure namespaces point at localhost', () => {
    expect(databaseConfig.parse({})).toMatchObject({
      url: 'postgres://app:app@localhost:5432/app',
      poolMax: 20,
      prepare: true,
      runMigrations: false,
    });
    expect(cassandraConfig.parse({})).toMatchObject({
      contactPoints: ['localhost'],
      port: 9042,
      localDataCenter: 'datacenter1',
      keyspace: 'app',
      credentials: undefined,
      consistency: 'localOne',
      runMigrations: true,
    });
    expect(redisConfig.parse({})).toEqual({
      url: 'redis://localhost:6379',
      keyPrefix: 'app',
      maxRetriesPerRequest: 3,
      connectTimeoutMs: 10_000,
    });
    expect(kafkaConfig.parse({})).toMatchObject({
      brokers: ['localhost:9094'],
      clientId: 'app',
      groupId: 'app',
      partitionsConsumedConcurrently: 3,
      ssl: false,
      sasl: undefined,
    });
    expect(grpcConfig.parse({})).toEqual({
      url: '0.0.0.0:50051',
      deadlineMs: 5000,
      maxMessageBytes: 4_194_304,
      tls: undefined,
      reflection: true,
    });
    expect(mailConfig.parse({})).toMatchObject({
      host: 'localhost',
      port: 1025,
      auth: undefined,
      pool: true,
    });
    expect(storageConfig.parse({})).toMatchObject({
      driver: 's3',
      s3: {
        endpoint: 'http://localhost:9000',
        publicEndpoint: 'http://localhost:9000',
        bucket: 'uploads',
      },
      gcs: { apiEndpoint: 'http://localhost:4443', keyFilename: undefined },
    });
  });

  it('auth, throttle-adjacent and graphql defaults', () => {
    expect(authConfig.parse({})).toEqual({
      accessSecret: DEV_JWT_ACCESS_SECRET,
      accessTtlSec: 900,
      issuer: 'nestjs-boilerplate',
      audience: 'nestjs-boilerplate',
      denylistEnabled: true,
      wsRevocationSweepIntervalMs: 30_000,
    } satisfies AuthConfig);
    expect(graphqlConfig.parse({})).toMatchObject({
      path: '/graphql',
      sandbox: true,
      introspection: true,
    });
    expect(throttleConfig.parse({})).toEqual({
      ttlMs: 60_000,
      limit: 300,
      ipTtlMs: 60_000,
      ipLimit: 600,
      tenantTtlMs: 60_000,
      tenantLimit: 3_000,
      graphqlTtlMs: 60_000,
      graphqlCostLimit: 20_000,
      wsHandshakeLimit: 30,
      wsHandshakeTtlMs: 60_000,
      wsSocketsPerUser: 10,
      wsSocketTtlMs: 3_600_000,
      redisTimeoutMs: 250,
    });
    expect(cacheConfig.parse({})).toEqual({ ttlMs: 30_000, l1TtlMs: 5000, l1MaxItems: 5000 });
  });
});

describe('config namespaces — derived values and coercion', () => {
  it('production flips the dev-friendly derived defaults', () => {
    const env = {
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
    };
    expect(appConfig.parse(env)).toMatchObject({ isProduction: true, docsEnabled: false });
    expect(observabilityConfig.parse(env).logPretty).toBe(false);
    expect(graphqlConfig.parse(env)).toMatchObject({ sandbox: false, introspection: false });
    expect(appConfig.parse({ ...env, DOCS_ENABLED: 'true' }).docsEnabled).toBe(true);
  });

  it('handler timeout is its own setting, independent of the request-receive timeout', () => {
    expect(appConfig.parse({})).toMatchObject({
      handlerTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
    });
    expect(appConfig.parse({ HTTP_HANDLER_TIMEOUT_MS: '5000' }).handlerTimeoutMs).toBe(5000);
    expect(() => appConfig.parse({ HTTP_HANDLER_TIMEOUT_MS: '0' })).toThrow(EnvValidationError);
  });

  it('coerces csv / bool / int values', () => {
    const app = appConfig.parse({
      PORT: '8080',
      CORS_ORIGINS: 'https://a.io, https://b.io,,https://a.io',
      TRUST_PROXY: '0',
      MAINTENANCE_MODE: 'TRUE',
      CLUSTER_WORKERS: '0',
    });
    expect(app).toMatchObject({
      port: 8080,
      corsOrigins: ['https://a.io', 'https://b.io'],
      trustProxy: false,
      maintenanceMode: true,
      clusterWorkers: 0,
    });
    expect(cassandraConfig.parse({ CASSANDRA_CONTACT_POINTS: 'c1,c2 , c3' }).contactPoints).toEqual(
      ['c1', 'c2', 'c3'],
    );
  });

  it('derives Kafka ids from SERVICE_NAME and builds SASL only when complete', () => {
    expect(kafkaConfig.parse({ SERVICE_NAME: 'orders-service' })).toMatchObject({
      clientId: 'orders-service',
      groupId: 'orders-service',
    });
    expect(
      kafkaConfig.parse({
        KAFKA_SASL_MECHANISM: 'scram-sha-512',
        KAFKA_SASL_USERNAME: 'u',
        KAFKA_SASL_PASSWORD: 'p',
      }).sasl,
    ).toEqual({ mechanism: 'scram-sha-512', username: 'u', password: 'p' });
    expect(errorOf(() => kafkaConfig.parse({ KAFKA_SASL_MECHANISM: 'plain' })).message).toContain(
      'KAFKA_SASL_USERNAME',
    );
  });

  it('observability: validates the OTel variables (the preload in otel.ts decides) and wires observe', () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4318' };
    expect(() =>
      observabilityConfig.parse({ ...endpoint, OTEL_SDK_DISABLED: 'true' }),
    ).not.toThrow();
    expect(() => observabilityConfig.parse({ ...endpoint, OTEL_SDK_DISABLED: 'maybe' })).toThrow(
      EnvValidationError,
    );
    expect(
      observabilityConfig.parse({
        OBSERVE_APP_KEY: 'k',
        OBSERVE_APP_SECRET: 's',
        SERVICE_NAME: 'gw',
      }).observe,
    ).toEqual({ enabled: true, appKey: 'k', appSecret: 's', serviceId: 'gw' });
  });

  it('storage holds no upload limits (a domain namespace owns them)', () => {
    const storage = storageConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1024' });
    expect(storage).not.toHaveProperty('maxUploadBytes');
    expect(storage).not.toHaveProperty('maxConcurrentUploads');
  });

  it('storage: public endpoint defaults to the endpoint', () => {
    expect(
      storageConfig.parse({
        S3_ENDPOINT: 'http://rustfs:9000',
        S3_PUBLIC_ENDPOINT: 'https://cdn.example.com',
      }).s3,
    ).toMatchObject({ endpoint: 'http://rustfs:9000', publicEndpoint: 'https://cdn.example.com' });
  });
});

describe('config namespaces — invalid values produce errors naming the env var', () => {
  it.each([
    [appConfig, { PORT: 'eighty' }, 'PORT'],
    [appConfig, { NODE_ENV: 'staging' }, 'NODE_ENV'],
    [databaseConfig, { DATABASE_URL: 'mysql://x' }, 'DATABASE_URL'],
    [databaseConfig, { DATABASE_POOL_MAX: '0' }, 'DATABASE_POOL_MAX'],
    [redisConfig, { REDIS_URL: 'localhost:6379' }, 'REDIS_URL'],
    [cassandraConfig, { CASSANDRA_KEYSPACE: 'app; DROP KEYSPACE x' }, 'CASSANDRA_KEYSPACE'],
    [cassandraConfig, { CASSANDRA_USERNAME: 'only-user' }, 'CASSANDRA_PASSWORD'],
    [mailConfig, { SMTP_SECURE: 'yes' }, 'SMTP_SECURE'],
    [storageConfig, { STORAGE_DRIVER: 'azure' }, 'STORAGE_DRIVER'],
    [storageConfig, { STORAGE_SIGNED_URL_TTL_SEC: '999999' }, 'STORAGE_SIGNED_URL_TTL_SEC'],
    [cacheConfig, { CACHE_L1_TTL_MS: '60000' }, 'CACHE_L1_TTL_MS'],
    [observabilityConfig, { METRICS_BEARER_TOKEN: 'short' }, 'METRICS_BEARER_TOKEN'],
    [authConfig, { JWT_ACCESS_SECRET: 'short' }, 'JWT_ACCESS_SECRET'],
    [appConfig, { TRUST_PROXY: 'yes' }, 'TRUST_PROXY'],
  ] as const)('%# → %s', (ns, env, variable) => {
    const error = errorOf(() => ns.parse(env));
    expect(error.namespace).toBe(ns.namespace);
    expect(error.message).toContain(`Invalid environment for "${ns.namespace}"`);
    expect(error.message).toContain(`→ at ${variable}`);
  });

  it('validateAllEnv aggregates failures across namespaces with namespaced paths', () => {
    const error = errorOf(() => validateAllEnv({ PORT: 'x', REDIS_URL: 'nope' }));
    expect(error.namespace).toBe('*');
    expect(error.message).toContain('→ at app.PORT');
    expect(error.message).toContain('→ at redis.REDIS_URL');
  });
});

describe('auth WS_REVOCATION_SWEEP_INTERVAL_MS', () => {
  const intervalOf = (value: string): number =>
    authConfig.parse({ WS_REVOCATION_SWEEP_INTERVAL_MS: value }).wsRevocationSweepIntervalMs;

  it('defaults to 30 s and accepts the 100 ms floor', () => {
    expect(authConfig.parse({}).wsRevocationSweepIntervalMs).toBe(30_000);
    expect(intervalOf('100')).toBe(100);
    expect(intervalOf('300000')).toBe(300_000);
  });

  it.each(['99', '300001', '250.5', 'often'])('rejects %s', (value) => {
    expect(errorOf(() => intervalOf(value)).message).toContain(
      '→ at WS_REVOCATION_SWEEP_INTERVAL_MS',
    );
  });
});

describe('app TRUST_PROXY', () => {
  const trustProxyOf = (TRUST_PROXY: string, NODE_ENV = 'development'): AppConfig['trustProxy'] =>
    appConfig.parse({ NODE_ENV, TRUST_PROXY }).trustProxy;

  it('trusts nobody by default, so X-Forwarded-For cannot choose req.ip', () => {
    expect(appConfig.parse({}).trustProxy).toBe(false);
    expect(appConfig.parse({ NODE_ENV: 'production' }).trustProxy).toBe(false);
  });

  it('parses booleans and IP/CIDR/preset lists', () => {
    expect(trustProxyOf('TRUE')).toBe(true);
    expect(trustProxyOf('1')).toBe(true);
    expect(trustProxyOf('false')).toBe(false);
    expect(trustProxyOf('0')).toBe(false);
    expect(trustProxyOf('10.0.0.0/8, 192.168.1.7,fd00::/8 , uniquelocal', 'production')).toEqual([
      '10.0.0.0/8',
      '192.168.1.7',
      'fd00::/8',
      'uniquelocal',
    ]);
  });

  it('rejects TRUST_PROXY=true in production (every hop trusted = spoofable client IP)', () => {
    for (const TRUST_PROXY of ['true', '1']) {
      const error = errorOf(() => appConfig.parse({ NODE_ENV: 'production', TRUST_PROXY }));
      expect(error.message).toContain('→ at TRUST_PROXY');
    }
  });

  it('rejects hop counts (Fastify fails closed on them) and malformed entries', () => {
    for (const TRUST_PROXY of ['2', '10.0.0.0/33', '10.0.0.0/8, lb.internal']) {
      expect(errorOf(() => appConfig.parse({ TRUST_PROXY })).message).toContain('→ at TRUST_PROXY');
    }
  });
});

describe('registered factories', () => {
  it('expose Nest config tokens and read process.env lazily', () => {
    expect(appConfig.KEY).toBe('CONFIGURATION(app)');
    expect(redisConfig.KEY).toBe('CONFIGURATION(redis)');
    const previous = process.env['REDIS_KEY_PREFIX'];
    process.env['REDIS_KEY_PREFIX'] = 'lazy';
    try {
      expect(redisConfig().keyPrefix).toBe('lazy');
    } finally {
      if (previous === undefined) delete process.env['REDIS_KEY_PREFIX'];
      else process.env['REDIS_KEY_PREFIX'] = previous;
    }
  });

  it('keep precise inferred types', () => {
    expectTypeOf<AppConfig['port']>().toEqualTypeOf<number>();
    expectTypeOf<AppConfig['nodeEnv']>().toEqualTypeOf<'development' | 'test' | 'production'>();
    expectTypeOf<AuthConfig['accessTtlSec']>().toEqualTypeOf<number>();
    expectTypeOf(storageConfig.parse)
      .returns.toHaveProperty('driver')
      .toEqualTypeOf<'s3' | 'gcs'>();
  });
});
