import { describe, expect, it } from 'vitest';
import { EnvValidationError } from '../env/parse-env.js';
import { isKnownLocalSecret, isLoopbackHost } from '../env/production-guards.js';
import { appConfig } from './app.config.js';
import { authConfig, DEV_JWT_ACCESS_SECRET, DEV_JWT_REFRESH_SECRET } from './auth.config.js';
import { cassandraConfig } from './cassandra.config.js';
import { databaseConfig } from './database.config.js';
import { kafkaConfig } from './kafka.config.js';
import { mailConfig } from './mail.config.js';
import { redisConfig } from './redis.config.js';
import { storageConfig } from './storage.config.js';
import { stripeConfig } from './stripe.config.js';

const PROD = { NODE_ENV: 'production' } as const;

/** The docker-compose fallbacks (docker-compose.yml x-env-auth / x-env-stripe / x-env-storage). */
const COMPOSE = {
  JWT_ACCESS_SECRET: 'compose-local-access-secret-not-for-production-0001',
  JWT_REFRESH_SECRET: 'compose-local-refresh-secret-not-for-production-0002',
  STRIPE_SECRET_KEY: 'sk_test_compose_local_not_for_production',
  STRIPE_WEBHOOK_SECRET: 'whsec_compose_local_not_for_production',
  S3_ACCESS_KEY_ID: 'rustfsadmin',
  S3_SECRET_ACCESS_KEY: 'rustfsadmin',
} as const;

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('production guard helpers', () => {
  it('recognises the public local secrets and obvious placeholders', () => {
    for (const value of [
      ...Object.values(COMPOSE),
      DEV_JWT_ACCESS_SECRET,
      'sk_test_placeholder',
      'change-me-before-deploying',
    ]) {
      expect(isKnownLocalSecret(value), value).toBe(true);
    }
    for (const value of [undefined, 'Zr4mW9vQ2L8kT1xN6pB3yH7cJ5sD0fGa', 'sk_live_51HxRealKey']) {
      expect(isKnownLocalSecret(value), String(value)).toBe(false);
    }
  });

  it('recognises loopback hosts', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['db.internal', '10.0.0.5', 'example.com', 'localhost.example.com']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('auth: known local secrets', () => {
  it('rejects the compose fallbacks in production unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const env = {
      ...PROD,
      JWT_ACCESS_SECRET: COMPOSE.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: COMPOSE.JWT_REFRESH_SECRET,
    };
    const error = errorOf(() => authConfig.parse(env));
    expect(error.message).toContain('→ at JWT_ACCESS_SECRET');
    expect(error.message).toContain('→ at JWT_REFRESH_SECRET');
    expect(error.message).toContain('ALLOW_KNOWN_LOCAL_SECRETS');
    expect(authConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).accessSecret).toBe(
      COMPOSE.JWT_ACCESS_SECRET,
    );
  });

  it('never accepts the development defaults in production, even with the opt-out', () => {
    const error = errorOf(() => authConfig.parse({ ...PROD, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }));
    expect(error.message).toContain('→ at JWT_ACCESS_SECRET');
    expect(error.message).toContain('development default');
    expect(DEV_JWT_REFRESH_SECRET).toContain('change-me');
  });
});

describe('stripe: known local secrets and redirect URLs', () => {
  const REAL = {
    STRIPE_SECRET_KEY: 'sk_live_51HxRealKey',
    STRIPE_WEBHOOK_SECRET: 'whsec_1a2b3c',
    STRIPE_SUCCESS_URL: 'https://app.example.com/billing/success',
    STRIPE_CANCEL_URL: 'https://app.example.com/billing/cancel',
  };

  it('rejects the compose fallback keys in production unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const env = {
      ...PROD,
      ...REAL,
      STRIPE_SECRET_KEY: COMPOSE.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: COMPOSE.STRIPE_WEBHOOK_SECRET,
    };
    const error = errorOf(() => stripeConfig.parse(env));
    expect(error.message).toContain('→ at STRIPE_SECRET_KEY');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
    expect(stripeConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).secretKey).toBe(
      COMPOSE.STRIPE_SECRET_KEY,
    );
  });

  it('requires https, non-loopback Checkout redirect URLs in production', () => {
    const local = errorOf(() =>
      stripeConfig.parse({
        ...PROD,
        STRIPE_SECRET_KEY: REAL.STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: REAL.STRIPE_WEBHOOK_SECRET,
      }),
    );
    expect(local.message).toContain('→ at STRIPE_SUCCESS_URL');
    expect(local.message).toContain('→ at STRIPE_CANCEL_URL');
    expect(local.message).toContain('STRIPE_ALLOW_LOCAL_REDIRECTS');
    const plainHttp = errorOf(() =>
      stripeConfig.parse({ ...PROD, ...REAL, STRIPE_SUCCESS_URL: 'http://app.example.com/ok' }),
    );
    expect(plainHttp.message).toContain('→ at STRIPE_SUCCESS_URL');
    expect(stripeConfig.parse({ ...PROD, ...REAL }).successUrl).toBe(REAL.STRIPE_SUCCESS_URL);
    expect(
      stripeConfig.parse({
        ...PROD,
        STRIPE_SECRET_KEY: REAL.STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: REAL.STRIPE_WEBHOOK_SECRET,
        STRIPE_ALLOW_LOCAL_REDIRECTS: 'true',
      }).cancelUrl,
    ).toBe('http://localhost:3000/billing/cancel');
  });
});

describe('database: TLS in production', () => {
  it('requires an sslmode that encrypts (require / verify-ca / verify-full) unless opted out', () => {
    const error = errorOf(() => databaseConfig.parse(PROD));
    expect(error.message).toContain('→ at DATABASE_URL');
    expect(error.message).toContain('DATABASE_ALLOW_INSECURE');
    for (const sslmode of ['disable', 'allow', 'prefer']) {
      const url = `postgres://u:p@db.internal:5432/app?sslmode=${sslmode}`;
      expect(() => databaseConfig.parse({ ...PROD, DATABASE_URL: url }), sslmode).toThrow(
        EnvValidationError,
      );
    }
    for (const query of [
      'sslmode=require',
      'sslmode=verify-ca',
      'sslmode=verify-full',
      'sslrootcert=system',
    ]) {
      const url = `postgres://u:p@db.internal:5432/app?${query}`;
      expect(databaseConfig.parse({ ...PROD, DATABASE_URL: url }).url, query).toBe(url);
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

describe('redis: TLS and AUTH in production', () => {
  it('requires rediss:// with a password unless opted out, without echoing the URL', () => {
    const error = errorOf(() => redisConfig.parse(PROD));
    expect(error.message).toContain('→ at REDIS_URL');
    expect(error.message).toContain('REDIS_ALLOW_INSECURE');
    for (const url of ['redis://:pw-s3cr3t@cache.internal:6379', 'rediss://cache.internal:6380']) {
      const failure = errorOf(() => redisConfig.parse({ ...PROD, REDIS_URL: url }));
      expect(failure.message).not.toContain('pw-s3cr3t');
    }
    const secure = 'rediss://app:pw@cache.internal:6380';
    expect(redisConfig.parse({ ...PROD, REDIS_URL: secure }).url).toBe(secure);
    expect(redisConfig.parse({ ...PROD, REDIS_ALLOW_INSECURE: 'true' }).url).toBe(
      'redis://localhost:6379',
    );
  });
});

describe('kafka: TLS in production', () => {
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

describe('mail: STARTTLS and real addresses in production', () => {
  const REAL = { SMTP_HOST: 'smtp.sendgrid.net', MAIL_FROM: 'Acme <no-reply@acme.io>' };

  it('rejects the Mailpit host and the example.com sender unless opted out', () => {
    const error = errorOf(() => mailConfig.parse(PROD));
    expect(error.message).toContain('→ at SMTP_HOST');
    expect(error.message).toContain('→ at MAIL_FROM');
    expect(error.message).toContain('SMTP_ALLOW_INSECURE');
    expect(mailConfig.parse({ ...PROD, SMTP_ALLOW_INSECURE: 'true' }).requireTls).toBe(false);
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

describe('cassandra: TLS and replication', () => {
  const TLS = { CASSANDRA_SSL: 'true', CASSANDRA_TLS_CA_PATH: '/etc/cassandra/ca.pem' };

  it('requires TLS and NetworkTopologyStrategy in production unless opted out', () => {
    const error = errorOf(() => cassandraConfig.parse(PROD));
    expect(error.message).toContain('→ at CASSANDRA_SSL');
    expect(error.message).toContain('→ at CASSANDRA_REPLICATION_DATACENTERS');
    expect(error.message).toContain('CASSANDRA_ALLOW_INSECURE');
    expect(cassandraConfig.parse({ ...PROD, CASSANDRA_ALLOW_INSECURE: 'true' })).toMatchObject({
      tls: undefined,
      replication: { class: 'SimpleStrategy', replicationFactor: 1 },
    });
  });

  it('builds TLS and NetworkTopologyStrategy from env', () => {
    const cfg = cassandraConfig.parse({
      ...PROD,
      ...TLS,
      CASSANDRA_TLS_CERT_PATH: '/etc/cassandra/client.crt',
      CASSANDRA_TLS_KEY_PATH: '/etc/cassandra/client.key',
      CASSANDRA_REPLICATION_DATACENTERS: 'dc1:3, dc2:2',
    });
    expect(cfg.tls).toEqual({
      caPath: '/etc/cassandra/ca.pem',
      certPath: '/etc/cassandra/client.crt',
      keyPath: '/etc/cassandra/client.key',
    });
    expect(cfg.replication).toEqual({
      class: 'NetworkTopologyStrategy',
      dataCenters: { dc1: 3, dc2: 2 },
    });
  });

  it('rejects a client cert without its key, and malformed data center lists', () => {
    const lonelyCert = errorOf(() =>
      cassandraConfig.parse({ ...TLS, CASSANDRA_TLS_CERT_PATH: '/etc/cassandra/client.crt' }),
    );
    expect(lonelyCert.message).toContain('→ at CASSANDRA_TLS_KEY_PATH');
    for (const value of ['dc1', 'dc1:0', 'dc1:x', 'dc 1:3']) {
      expect(
        () => cassandraConfig.parse({ CASSANDRA_REPLICATION_DATACENTERS: value }),
        value,
      ).toThrow(EnvValidationError);
    }
  });
});

describe('storage: emulator endpoints and local keys', () => {
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
    expect(error.message).toContain('ALLOW_KNOWN_LOCAL_SECRETS');
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

  it('rejects the GCS emulator in production and exposes the public signing endpoint', () => {
    const gcs = { ...PROD, STORAGE_DRIVER: 'gcs' };
    const error = errorOf(() => storageConfig.parse(gcs));
    expect(error.message).toContain('→ at GCS_API_ENDPOINT');
    expect(
      storageConfig.parse({ ...gcs, GCS_API_ENDPOINT: 'https://storage.googleapis.com' }).gcs
        .publicEndpoint,
    ).toBeUndefined();
    expect(
      storageConfig.parse({ GCS_PUBLIC_ENDPOINT: 'http://localhost:4443' }).gcs.publicEndpoint,
    ).toBe('http://localhost:4443');
  });
});

describe('app: CORS in production', () => {
  it('rejects a wildcard origin in production (credentials are enabled)', () => {
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
