import { describe, expect, it } from 'vitest';
import { errorOf } from '../../test/error-of.js';
import { EnvValidationError } from '../env/parse-env.js';
import { appConfig } from './app.config.js';
import { authConfig, DEV_JWT_ACCESS_SECRET } from './auth.config.js';
import { cassandraConfig } from './cassandra.config.js';
import { databaseConfig } from './database.config.js';
import { grpcConfig } from './grpc.config.js';
import { kafkaConfig } from './kafka.config.js';
import { mailConfig } from './mail.config.js';
import { redisConfig } from './redis.config.js';
import { storageConfig } from './storage.config.js';
import {
  PLACEHOLDER_STRIPE_SECRET_KEY,
  PLACEHOLDER_STRIPE_WEBHOOK_SECRET,
  stripeConfig,
} from './stripe.config.js';

/**
 * Every NODE_ENV=production guard of the config namespaces, one describe per namespace. The
 * helpers they share (isKnownLocalSecret, isLoopbackHost, …) are tested in env/production-guards.spec.ts.
 */

const PROD = { NODE_ENV: 'production' } as const;

/** The docker-compose fallbacks (docker-compose.yml x-env-auth / x-env-stripe / x-env-storage). */
const COMPOSE = {
  JWT_ACCESS_SECRET: 'compose-local-access-secret-not-for-production-0001',
  STRIPE_SECRET_KEY: 'sk_test_compose_local_not_for_production',
  STRIPE_WEBHOOK_SECRET: 'whsec_compose_local_not_for_production',
} as const;

const KNOWN_VALUE_MESSAGE = 'is a publicly known value';

describe('auth', () => {
  it('rejects the development default secrets in production, without echoing them', () => {
    const error = errorOf(() => authConfig.parse(PROD));
    expect(error.message).toContain('→ at JWT_ACCESS_SECRET');
    expect(error.message).toContain('development default');
    expect(error.message).not.toContain(DEV_JWT_ACCESS_SECRET);
    // The opt-out covers the compose fallbacks only, never the development defaults.
    const optedOut = errorOf(() =>
      authConfig.parse({ ...PROD, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }),
    );
    expect(optedOut.message).toContain('development default');
  });

  it('rejects the compose fallbacks in production unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const env = { ...PROD, ...COMPOSE };
    const error = errorOf(() => authConfig.parse(env));
    expect(error.message).toContain('→ at JWT_ACCESS_SECRET');
    expect(error.message).toContain(KNOWN_VALUE_MESSAGE);
    expect(error.message).toContain('ALLOW_KNOWN_LOCAL_SECRETS');
    expect(authConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).accessSecret).toBe(
      COMPOSE.JWT_ACCESS_SECRET,
    );
  });

  it('accepts strong distinct secrets in production and dev defaults elsewhere', () => {
    expect(
      authConfig.parse({
        ...PROD,
        JWT_ACCESS_SECRET: 'a'.repeat(48),
      }).accessSecret,
    ).toBe('a'.repeat(48));
    expect(authConfig.parse({ NODE_ENV: 'test' }).accessSecret).toBe(DEV_JWT_ACCESS_SECRET);
  });
});

describe('stripe', () => {
  const REAL = {
    STRIPE_SECRET_KEY: 'sk_live_51HxRealKey',
    STRIPE_WEBHOOK_SECRET: 'whsec_1a2b3c4d5e6f7g8h9i0j',
    STRIPE_SUCCESS_URL: 'https://app.example.com/billing/success',
    STRIPE_CANCEL_URL: 'https://app.example.com/billing/cancel',
  };

  it('rejects the development placeholders in production (forged webhooks would verify)', () => {
    const error = errorOf(() => stripeConfig.parse(PROD));
    expect(error.message).toContain('→ at STRIPE_SECRET_KEY');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
  });

  it('rejects the compose fallbacks and the docs placeholders unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const compose = {
      ...PROD,
      ...REAL,
      STRIPE_SECRET_KEY: COMPOSE.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: COMPOSE.STRIPE_WEBHOOK_SECRET,
    };
    const error = errorOf(() => stripeConfig.parse(compose));
    expect(error.message).toContain('→ at STRIPE_SECRET_KEY');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
    expect(error.message).toContain(KNOWN_VALUE_MESSAGE);
    expect(stripeConfig.parse({ ...compose, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).secretKey).toBe(
      COMPOSE.STRIPE_SECRET_KEY,
    );
    // Copied unfilled from .env.example / the production checklist.
    const unfilled = errorOf(() =>
      stripeConfig.parse({ ...PROD, ...REAL, STRIPE_WEBHOOK_SECRET: 'whsec_...' }),
    );
    expect(unfilled.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
  });

  it('requires https, non-loopback Checkout redirect URLs in production', () => {
    const keys = {
      STRIPE_SECRET_KEY: REAL.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: REAL.STRIPE_WEBHOOK_SECRET,
    };
    const local = errorOf(() => stripeConfig.parse({ ...PROD, ...keys }));
    expect(local.message).toContain('→ at STRIPE_SUCCESS_URL');
    expect(local.message).toContain('→ at STRIPE_CANCEL_URL');
    expect(local.message).toContain('STRIPE_ALLOW_LOCAL_REDIRECTS');
    const plainHttp = errorOf(() =>
      stripeConfig.parse({ ...PROD, ...REAL, STRIPE_SUCCESS_URL: 'http://app.example.com/ok' }),
    );
    expect(plainHttp.message).toContain('→ at STRIPE_SUCCESS_URL');
    expect(stripeConfig.parse({ ...PROD, ...REAL }).successUrl).toBe(REAL.STRIPE_SUCCESS_URL);
    expect(
      stripeConfig.parse({ ...PROD, ...keys, STRIPE_ALLOW_LOCAL_REDIRECTS: 'true' }).cancelUrl,
    ).toBe('http://localhost:3000/billing/cancel');
  });

  it('keeps the placeholders outside production', () => {
    expect(stripeConfig.parse({ NODE_ENV: 'test' }).secretKey).toBe(PLACEHOLDER_STRIPE_SECRET_KEY);
    expect(stripeConfig.parse({}).webhookSecret).toBe(PLACEHOLDER_STRIPE_WEBHOOK_SECRET);
  });
});

describe('grpc', () => {
  const TLS = {
    GRPC_TLS_CA_PATH: '/etc/grpc/ca.pem',
    GRPC_TLS_CERT_PATH: '/etc/grpc/tls.crt',
    GRPC_TLS_KEY_PATH: '/etc/grpc/tls.key',
  };

  it('refuses plaintext gRPC in production unless explicitly allowed', () => {
    const error = errorOf(() => grpcConfig.parse(PROD));
    expect(error.message).toContain('→ at GRPC_TLS_CERT_PATH');
    expect(error.message).toContain('GRPC_ALLOW_INSECURE');
    expect(grpcConfig.parse({ ...PROD, GRPC_ALLOW_INSECURE: 'true' })).toMatchObject({
      tls: undefined,
      reflection: false,
    });
  });

  it('builds mutual TLS from the PEM paths (client certs required by default)', () => {
    expect(grpcConfig.parse({ ...PROD, ...TLS })).toMatchObject({
      tls: {
        caPath: '/etc/grpc/ca.pem',
        certPath: '/etc/grpc/tls.crt',
        keyPath: '/etc/grpc/tls.key',
        requireClientCert: true,
      },
      reflection: false,
    });
  });

  it('rejects a cert without a key, and required client certs without a CA', () => {
    expect(errorOf(() => grpcConfig.parse({ GRPC_TLS_CERT_PATH: '/c' })).message).toContain(
      '→ at GRPC_TLS_KEY_PATH',
    );
    expect(
      errorOf(() => grpcConfig.parse({ GRPC_TLS_CERT_PATH: '/c', GRPC_TLS_KEY_PATH: '/k' }))
        .message,
    ).toContain('→ at GRPC_TLS_CA_PATH');
    expect(
      grpcConfig.parse({
        GRPC_TLS_CERT_PATH: '/c',
        GRPC_TLS_KEY_PATH: '/k',
        GRPC_TLS_REQUIRE_CLIENT_CERT: 'false',
      }).tls,
    ).toEqual({ caPath: undefined, certPath: '/c', keyPath: '/k', requireClientCert: false });
  });

  it('keeps reflection on outside production unless disabled', () => {
    expect(grpcConfig.parse({ NODE_ENV: 'test' }).reflection).toBe(true);
    expect(grpcConfig.parse({ GRPC_REFLECTION: 'false' }).reflection).toBe(false);
  });
});

describe('database', () => {
  const url = (query: string): string => `postgres://u:p@db.internal:5432/app?${query}`;

  it('requires the TLS mode postgres.js will actually use to encrypt, unless opted out', () => {
    const error = errorOf(() => databaseConfig.parse(PROD));
    expect(error.message).toContain('→ at DATABASE_URL');
    expect(error.message).toContain('DATABASE_ALLOW_INSECURE');
    for (const query of [
      'sslmode=require',
      'sslmode=verify-ca',
      'sslmode=verify-full',
      'sslrootcert=system',
      'ssl=true',
      'ssl=require',
      // postgres.js reads the LAST value of a repeated parameter
      'sslmode=disable&sslmode=verify-full',
    ]) {
      expect(databaseConfig.parse({ ...PROD, DATABASE_URL: url(query) }).url, query).toBe(
        url(query),
      );
    }
    for (const query of [
      'sslmode=disable',
      'sslmode=allow',
      'sslmode=prefer',
      'ssl=false',
      'sslmode=verify-full&sslmode=disable',
      'sslrootcert=system&sslrootcert=/etc/ca.pem',
    ]) {
      expect(() => databaseConfig.parse({ ...PROD, DATABASE_URL: url(query) }), query).toThrow(
        EnvValidationError,
      );
    }
    expect(databaseConfig.parse({ ...PROD, DATABASE_ALLOW_INSECURE: 'true' }).url).toContain(
      'localhost',
    );
  });

  it('never echoes the URL (it carries the password) in the error', () => {
    const error = errorOf(() =>
      databaseConfig.parse({ ...PROD, DATABASE_URL: 'postgres://u:s3cr3t@db.internal:5432/app' }),
    );
    expect(error.message).not.toContain('s3cr3t');
  });
});

describe('redis', () => {
  it('requires a lowercase rediss:// URL with a password, as ioredis reads it', () => {
    const error = errorOf(() => redisConfig.parse(PROD));
    expect(error.message).toContain('→ at REDIS_URL');
    expect(error.message).toContain('REDIS_ALLOW_INSECURE');
    for (const insecure of [
      'redis://:pw-s3cr3t@cache.internal:6379',
      'rediss://cache.internal:6380',
      // ioredis enables TLS only for a lowercase prefix, and a `tls` parameter overrides it
      'REDISS://app:pw-s3cr3t@cache.internal:6380',
      'rediss://app:pw-s3cr3t@cache.internal:6380?tls=',
    ]) {
      const failure = errorOf(() => redisConfig.parse({ ...PROD, REDIS_URL: insecure }));
      expect(failure.message, insecure).toContain('→ at REDIS_URL');
      expect(failure.message).not.toContain('pw-s3cr3t');
    }
    const secure = 'rediss://app:pw@cache.internal:6380';
    expect(redisConfig.parse({ ...PROD, REDIS_URL: secure }).url).toBe(secure);
    expect(redisConfig.parse({ ...PROD, REDIS_ALLOW_INSECURE: 'true' }).url).toBe(
      'redis://localhost:6379',
    );
  });
});

describe('kafka', () => {
  it('requires KAFKA_SSL (so SASL never travels in plaintext) unless opted out', () => {
    const error = errorOf(() => kafkaConfig.parse(PROD));
    expect(error.message).toContain('→ at KAFKA_SSL');
    expect(error.message).toContain('KAFKA_ALLOW_INSECURE');
    const plainOverPlaintext = errorOf(() =>
      kafkaConfig.parse({
        ...PROD,
        KAFKA_SASL_MECHANISM: 'plain',
        KAFKA_SASL_USERNAME: 'u',
        KAFKA_SASL_PASSWORD: 'p',
      }),
    );
    expect(plainOverPlaintext.message).toContain('→ at KAFKA_SSL');
    expect(kafkaConfig.parse({ ...PROD, KAFKA_SSL: 'true' }).ssl).toBe(true);
    expect(kafkaConfig.parse({ ...PROD, KAFKA_ALLOW_INSECURE: 'true' }).ssl).toBe(false);
  });
});

describe('mail', () => {
  const REAL = { SMTP_HOST: 'smtp.sendgrid.net', MAIL_FROM: 'Acme <no-reply@acme.io>' };

  it('rejects the Mailpit default and the example.com sender unless opted out', () => {
    const error = errorOf(() => mailConfig.parse(PROD));
    expect(error.message).toContain('→ at SMTP_HOST');
    expect(error.message).toContain('→ at MAIL_FROM');
    expect(error.message).toContain('SMTP_ALLOW_INSECURE');
    // Any spelling of loopback on the Mailpit port.
    const shorthand = errorOf(() =>
      mailConfig.parse({ ...PROD, ...REAL, SMTP_HOST: '127.1', SMTP_PORT: '1025' }),
    );
    expect(shorthand.message).toContain('→ at SMTP_HOST');
    expect(mailConfig.parse({ ...PROD, SMTP_ALLOW_INSECURE: 'true' }).requireTls).toBe(false);
  });

  it('accepts a local MTA relay: loopback traffic never leaves the host, so no STARTTLS needed', () => {
    const relay = mailConfig.parse({
      ...PROD,
      MAIL_FROM: REAL.MAIL_FROM,
      SMTP_HOST: 'localhost',
      SMTP_PORT: '25',
    });
    expect(relay).toMatchObject({ host: 'localhost', port: 25, requireTls: false });
  });

  it('requires TLS by default in production (STARTTLS when SMTP_SECURE=false)', () => {
    expect(mailConfig.parse({ ...PROD, ...REAL }).requireTls).toBe(true);
    expect(mailConfig.parse({ ...PROD, ...REAL, SMTP_SECURE: 'true' }).requireTls).toBe(false);
    const disabled = errorOf(() =>
      mailConfig.parse({ ...PROD, ...REAL, SMTP_REQUIRE_TLS: 'false' }),
    );
    expect(disabled.message).toContain('→ at SMTP_REQUIRE_TLS');
    expect(mailConfig.parse({}).requireTls).toBe(false);
    expect(mailConfig.parse({ SMTP_REQUIRE_TLS: 'true' }).requireTls).toBe(true);
  });
});

describe('cassandra', () => {
  const TLS = { CASSANDRA_SSL: 'true', CASSANDRA_TLS_CA_PATH: '/etc/cassandra/ca.pem' };

  it('requires TLS in production unless CASSANDRA_ALLOW_INSECURE', () => {
    const error = errorOf(() =>
      cassandraConfig.parse({ ...PROD, CASSANDRA_REPLICATION_DATACENTERS: 'dc1:3' }),
    );
    expect(error.message).toContain('→ at CASSANDRA_SSL');
    expect(error.message).toContain('CASSANDRA_ALLOW_INSECURE');
    expect(
      cassandraConfig.parse({
        ...PROD,
        CASSANDRA_ALLOW_INSECURE: 'true',
        CASSANDRA_REPLICATION_DATACENTERS: 'dc1:3',
      }).tls,
    ).toBeUndefined();
  });

  it('requires NetworkTopologyStrategy when this process creates the keyspace, with its own opt-out', () => {
    // The TLS opt-out (a mesh) must not silently allow SimpleStrategy.
    const meshOnly = errorOf(() =>
      cassandraConfig.parse({ ...PROD, CASSANDRA_ALLOW_INSECURE: 'true' }),
    );
    expect(meshOnly.message).toContain('→ at CASSANDRA_REPLICATION_DATACENTERS');
    expect(meshOnly.message).toContain('CASSANDRA_ALLOW_SIMPLE_STRATEGY');
    expect(
      cassandraConfig.parse({
        ...PROD,
        CASSANDRA_ALLOW_INSECURE: 'true',
        CASSANDRA_ALLOW_SIMPLE_STRATEGY: 'true',
      }).replication,
    ).toEqual({ class: 'SimpleStrategy', replicationFactor: 1 });
    // A process that never creates the keyspace does not need it.
    expect(() =>
      cassandraConfig.parse({ ...PROD, ...TLS, CASSANDRA_RUN_MIGRATIONS: 'false' }),
    ).not.toThrow();
  });

  it('builds TLS and NetworkTopologyStrategy from env', () => {
    const cfg = cassandraConfig.parse({
      ...PROD,
      ...TLS,
      CASSANDRA_TLS_CERT_PATH: '/etc/cassandra/client.crt',
      CASSANDRA_TLS_KEY_PATH: '/etc/cassandra/client.key',
      CASSANDRA_REPLICATION_DATACENTERS: 'dc1:3, us-east-1:2',
    });
    expect(cfg.tls).toEqual({
      caPath: '/etc/cassandra/ca.pem',
      certPath: '/etc/cassandra/client.crt',
      keyPath: '/etc/cassandra/client.key',
    });
    expect(cfg.replication).toEqual({
      class: 'NetworkTopologyStrategy',
      dataCenters: { dc1: 3, 'us-east-1': 2 },
    });
  });

  it('rejects a client cert without its key, and malformed or repeated data centers', () => {
    const lonelyCert = errorOf(() =>
      cassandraConfig.parse({ ...TLS, CASSANDRA_TLS_CERT_PATH: '/etc/cassandra/client.crt' }),
    );
    expect(lonelyCert.message).toContain('→ at CASSANDRA_TLS_KEY_PATH');
    for (const value of ['dc1', 'dc1:0', 'dc1:x', 'dc 1:3', "dc1':3", 'dc1:3,dc1:2']) {
      const error = errorOf(() =>
        cassandraConfig.parse({ CASSANDRA_REPLICATION_DATACENTERS: value }),
      );
      expect(error.message, value).toContain('→ at CASSANDRA_REPLICATION_DATACENTERS');
    }
  });
});

describe('storage', () => {
  const AWS = {
    S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
    S3_ACCESS_KEY_ID: 'AKIAREALKEY0000',
    S3_SECRET_ACCESS_KEY: 'Zr4mW9vQ2L8kT1xN6pB3yH7cJ5sD0fGa',
  };

  it('rejects the RustFS endpoint and keys in production unless opted out', () => {
    const error = errorOf(() => storageConfig.parse(PROD));
    expect(error.message).toContain('→ at S3_ENDPOINT');
    expect(error.message).toContain('STORAGE_ALLOW_INSECURE');
    expect(error.message).toContain('→ at S3_ACCESS_KEY_ID');
    expect(error.message).toContain(KNOWN_VALUE_MESSAGE);
    expect(
      storageConfig.parse({
        ...PROD,
        STORAGE_ALLOW_INSECURE: 'true',
        ALLOW_KNOWN_LOCAL_SECRETS: 'true',
      }).s3.endpoint,
    ).toBe('http://localhost:9000');
    const plainPublic = errorOf(() =>
      storageConfig.parse({ ...PROD, ...AWS, S3_PUBLIC_ENDPOINT: 'http://files.example.com' }),
    );
    expect(plainPublic.message).toContain('→ at S3_PUBLIC_ENDPOINT');
    expect(storageConfig.parse({ ...PROD, ...AWS }).s3.endpoint).toBe(AWS.S3_ENDPOINT);
  });

  it('rejects the GCS emulator in production; a public signing host must be Google too', () => {
    const gcs = {
      ...PROD,
      STORAGE_DRIVER: 'gcs',
      GCS_API_ENDPOINT: 'https://storage.googleapis.com',
    };
    expect(
      errorOf(() => storageConfig.parse({ ...gcs, GCS_API_ENDPOINT: 'http://localhost:4443' }))
        .message,
    ).toContain('→ at GCS_API_ENDPOINT');
    // Only Google can serve a URL signed for GCS: a CDN or an http host would break every link.
    for (const GCS_PUBLIC_ENDPOINT of ['https://cdn.example.com', 'http://cdn.example.com']) {
      const error = errorOf(() => storageConfig.parse({ ...gcs, GCS_PUBLIC_ENDPOINT }));
      expect(error.message, GCS_PUBLIC_ENDPOINT).toContain('→ at GCS_PUBLIC_ENDPOINT');
    }
    expect(storageConfig.parse(gcs).gcs.publicEndpoint).toBeUndefined();
    expect(
      storageConfig.parse({ GCS_PUBLIC_ENDPOINT: 'http://localhost:4443' }).gcs.publicEndpoint,
    ).toBe('http://localhost:4443');
  });
});

describe('app', () => {
  it('rejects a wildcard CORS origin in production (credentials are enabled)', () => {
    for (const CORS_ORIGINS of ['*', 'https://app.example.com,*']) {
      const error = errorOf(() => appConfig.parse({ ...PROD, CORS_ORIGINS }));
      expect(error.message).toContain('→ at CORS_ORIGINS');
    }
    expect(
      appConfig.parse({ ...PROD, CORS_ORIGINS: 'https://app.example.com' }).corsOrigins,
    ).toEqual(['https://app.example.com']);
    expect(appConfig.parse({ CORS_ORIGINS: '*' }).corsOrigins).toEqual(['*']);
  });
});
