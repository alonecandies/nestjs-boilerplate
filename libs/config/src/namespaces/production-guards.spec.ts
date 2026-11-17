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

/**
 * Every NODE_ENV=production guard of the config namespaces, one describe per namespace. The
 * helpers they share (isKnownLocalSecret, isLoopbackHost, …) are tested in env/production-guards.spec.ts.
 */

const PROD = { NODE_ENV: 'production' } as const;

/** The docker-compose fallbacks (docker-compose.yml x-env-auth / x-env-storage). */
const COMPOSE = {
  JWT_ACCESS_SECRET: 'compose-local-access-secret-not-for-production-0001',
} as const;

const KNOWN_VALUE_MESSAGE = 'is a publicly known value';

describe('auth', () => {
  it('rejects the development default access secret in production, without echoing it', () => {
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

  it('accepts a strong access secret in production and the dev default elsewhere', () => {
    expect(
      authConfig.parse({
        ...PROD,
        JWT_ACCESS_SECRET: 'a'.repeat(48),
      }).accessSecret,
    ).toBe('a'.repeat(48));
    expect(authConfig.parse({ NODE_ENV: 'test' }).accessSecret).toBe(DEV_JWT_ACCESS_SECRET);
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
  /** Production requires the system pool (login, register, invitations, the purges need it). */
  const SYSTEM = {
    DATABASE_SYSTEM_URL: 'postgres://app_system:p@db.internal:5432/app?sslmode=verify-full',
  } as const;

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
      expect(
        databaseConfig.parse({ ...PROD, ...SYSTEM, DATABASE_URL: url(query) }).url,
        query,
      ).toBe(url(query));
    }
    for (const query of [
      'sslmode=disable',
      'sslmode=allow',
      'sslmode=prefer',
      'ssl=false',
      'sslmode=verify-full&sslmode=disable',
      'sslrootcert=system&sslrootcert=/etc/ca.pem',
    ]) {
      expect(
        () => databaseConfig.parse({ ...PROD, ...SYSTEM, DATABASE_URL: url(query) }),
        query,
      ).toThrow(EnvValidationError);
    }
    expect(
      databaseConfig.parse({ ...PROD, ...SYSTEM, DATABASE_ALLOW_INSECURE: 'true' }).url,
    ).toContain('localhost');
  });

  it('requires DATABASE_SYSTEM_URL in production only (no system pool: login and the purges fail)', () => {
    for (const env of [
      { ...PROD, DATABASE_URL: url('sslmode=verify-full') },
      { ...PROD, DATABASE_ALLOW_INSECURE: 'true' },
    ]) {
      const error = errorOf(() => databaseConfig.parse(env));
      expect(error.message).toContain('→ at DATABASE_SYSTEM_URL');
      expect(error.message).toContain('app_system');
      expect(databaseConfig.parse({ ...env, ...SYSTEM }).systemUrl).toBe(
        SYSTEM.DATABASE_SYSTEM_URL,
      );
    }
    // Development and tests still boot without it (no system pool; each system call is refused).
    for (const NODE_ENV of ['development', 'test']) {
      expect(databaseConfig.parse({ NODE_ENV }).systemUrl).toBeUndefined();
    }
  });

  it('never echoes the URL (it carries the password) in the error', () => {
    const error = errorOf(() =>
      databaseConfig.parse({ ...PROD, DATABASE_URL: 'postgres://u:s3cr3t@db.internal:5432/app' }),
    );
    expect(error.message).not.toContain('s3cr3t');
  });

  describe('three URLs (runtime, system, migration)', () => {
    const TLS = 'sslmode=verify-full';
    const pg = (user: string, hostPort: string, query = TLS): string =>
      `postgres://${user}:s3cr3t@${hostPort}/app?${query}`;
    /** The production topology of the sharding design §5: two pooled URLs, one direct. */
    const TOPOLOGY = {
      ...PROD,
      DATABASE_URL: pg('app_runtime', 'pgbouncer.internal:6432'),
      DATABASE_SYSTEM_URL: pg('app_system', 'pgbouncer.internal:6432'),
      DATABASE_MIGRATION_URL: pg('app_owner', 'db.internal:5432'),
      DATABASE_POOLER: 'pgbouncer',
      DATABASE_RUN_MIGRATIONS: 'true',
    } as const;
    /** Every guard below also holds with the TLS opt-out set. */
    const INSECURE = { ...TOPOLOGY, DATABASE_ALLOW_INSECURE: 'true' } as const;

    it('accepts the production topology, with the boot guard enforced by default', () => {
      expect(databaseConfig.parse(TOPOLOGY)).toMatchObject({
        url: TOPOLOGY.DATABASE_URL,
        systemUrl: TOPOLOGY.DATABASE_SYSTEM_URL,
        migrationUrl: TOPOLOGY.DATABASE_MIGRATION_URL,
        pooler: 'pgbouncer',
        bootGuard: 'enforce',
        runMigrations: true,
      });
      expect(databaseConfig.parse({ ...TOPOLOGY, DATABASE_BOOT_GUARD: 'enforce' }).bootGuard).toBe(
        'enforce',
      );
    });

    it.each(['DATABASE_SYSTEM_URL', 'DATABASE_MIGRATION_URL'] as const)(
      'requires TLS on %s too, unless opted out',
      (key) => {
        const plain = TOPOLOGY[key].replace(TLS, 'sslmode=prefer');
        const error = errorOf(() => databaseConfig.parse({ ...TOPOLOGY, [key]: plain }));
        expect(error.message).toContain(`→ at ${key}`);
        expect(error.message).toContain(`${key} must enable TLS in production`);
        expect(error.message).not.toContain('s3cr3t');
        expect(error.message).not.toContain('→ at DATABASE_URL');
        expect(databaseConfig.parse({ ...INSECURE, [key]: plain })).toBeDefined();
      },
    );

    it.each(['warn', 'off'])('rejects DATABASE_BOOT_GUARD=%s in production', (mode) => {
      for (const env of [TOPOLOGY, INSECURE]) {
        const error = errorOf(() => databaseConfig.parse({ ...env, DATABASE_BOOT_GUARD: mode }));
        expect(error.message).toContain('→ at DATABASE_BOOT_GUARD');
      }
      expect(databaseConfig.parse({ NODE_ENV: 'test', DATABASE_BOOT_GUARD: mode }).bootGuard).toBe(
        mode,
      );
    });

    it('rejects DATABASE_RUN_MIGRATIONS=true without DATABASE_MIGRATION_URL', () => {
      for (const env of [TOPOLOGY, INSECURE]) {
        const { DATABASE_MIGRATION_URL: _omitted, ...rest } = env;
        const error = errorOf(() => databaseConfig.parse(rest));
        expect(error.message).toContain('→ at DATABASE_MIGRATION_URL');
        expect(error.message).toContain('DATABASE_RUN_MIGRATIONS');
        expect(
          databaseConfig.parse({ ...rest, DATABASE_RUN_MIGRATIONS: 'false' }).migrationUrl,
        ).toBeUndefined();
      }
      // Outside production the factory refuses at the point of use instead.
      expect(databaseConfig.parse({ DATABASE_RUN_MIGRATIONS: 'true' }).runMigrations).toBe(true);
    });

    it.each(['DATABASE_SYSTEM_URL', 'DATABASE_MIGRATION_URL'] as const)(
      'rejects %s with the same user as DATABASE_URL',
      (key) => {
        for (const env of [TOPOLOGY, INSECURE]) {
          const host = key === 'DATABASE_SYSTEM_URL' ? 'pgbouncer.internal:6432' : 'db.internal';
          for (const user of ['app_runtime', 'app%5Fruntime']) {
            const error = errorOf(() => databaseConfig.parse({ ...env, [key]: pg(user, host) }));
            expect(error.message, user).toContain(`→ at ${key}`);
            expect(error.message).toContain('user');
            expect(error.message).not.toContain('s3cr3t');
          }
        }
        expect(
          databaseConfig.parse({
            NODE_ENV: 'development',
            DATABASE_URL: 'postgres://app:app@localhost:5432/app',
            [key]: 'postgres://app:app@localhost:5432/app',
          }),
        ).toBeDefined();
      },
    );

    it('with DATABASE_POOLER=pgbouncer, rejects a migration URL on the host and port of DATABASE_URL', () => {
      for (const env of [TOPOLOGY, INSECURE]) {
        for (const hostPort of ['pgbouncer.internal:6432', 'PGBOUNCER.internal:6432']) {
          const error = errorOf(() =>
            databaseConfig.parse({ ...env, DATABASE_MIGRATION_URL: pg('app_owner', hostPort) }),
          );
          expect(error.message, hostPort).toContain('→ at DATABASE_MIGRATION_URL');
          expect(error.message).toContain('PgBouncer');
          expect(error.message).not.toContain('s3cr3t');
        }
        // The port defaults to 5432 on either side.
        expect(() =>
          databaseConfig.parse({
            ...env,
            DATABASE_URL: pg('app_runtime', 'pool.internal'),
            DATABASE_MIGRATION_URL: pg('app_owner', 'pool.internal:5432'),
          }),
        ).toThrow(EnvValidationError);
        // Same host, another port: the coordinator next to the pooler.
        expect(
          databaseConfig.parse({
            ...env,
            DATABASE_MIGRATION_URL: pg('app_owner', 'pgbouncer.internal:5432'),
          }).migrationUrl,
        ).toContain('pgbouncer.internal:5432');
      }
      // Without a pooler the runtime and the migrator may share the coordinator's address.
      expect(
        databaseConfig.parse({
          ...TOPOLOGY,
          DATABASE_POOLER: 'none',
          DATABASE_MIGRATION_URL: pg('app_owner', 'pgbouncer.internal:6432'),
        }).pooler,
      ).toBe('none');
    });
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
