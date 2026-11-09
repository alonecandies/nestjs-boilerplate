import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASSANDRA_CONSISTENCIES, cassandraConfig } from '@platform/config';
import cassandra from 'cassandra-driver';
import { describe, expect, it, onTestFinished } from 'vitest';
import { DEFAULT_FETCH_SIZE } from '../cassandra.constants.js';
import {
  assertCqlIdentifier,
  buildClientOptions,
  createKeyspaceCql,
  replicationToCql,
  toConsistency,
} from './client-options.js';

const { auth, types } = cassandra;

const cfg = cassandraConfig.parse({
  CASSANDRA_CONTACT_POINTS: 'cass-1,cass-2',
  CASSANDRA_PORT: '9142',
  CASSANDRA_LOCAL_DC: 'eu-west-1',
  CASSANDRA_KEYSPACE: 'alerts',
  CASSANDRA_CONSISTENCY: 'localQuorum',
  CASSANDRA_CORE_CONNECTIONS: '3',
  CASSANDRA_REQUEST_TIMEOUT_MS: '8000',
});

describe('buildClientOptions', () => {
  it('maps the cassandra namespace onto tuned driver options', () => {
    const options = buildClientOptions(cfg, {
      applicationName: 'alerts-service',
      keyspace: 'alerts',
    });
    expect(options).toMatchObject({
      contactPoints: ['cass-1', 'cass-2'],
      localDataCenter: 'eu-west-1',
      keyspace: 'alerts',
      protocolOptions: { port: 9142, maxSchemaAgreementWaitSeconds: 30 },
      pooling: {
        coreConnectionsPerHost: { [types.distance.local]: 3, [types.distance.remote]: 1 },
        maxRequestsPerConnection: 2048,
      },
      queryOptions: {
        prepare: true,
        consistency: types.consistencies.localQuorum,
        serialConsistency: types.consistencies.localSerial,
        fetchSize: DEFAULT_FETCH_SIZE,
        isIdempotent: false,
      },
      socketOptions: { readTimeout: 8000 },
      encoding: { useUndefinedAsUnset: true, useBigIntAsLong: true },
      monitorReporting: { enabled: false },
      applicationName: 'alerts-service',
    });
    expect(options.authProvider).toBeUndefined();
  });

  it('omits the keyspace for the bootstrap client', () => {
    expect(buildClientOptions(cfg, { applicationName: 'x' })).not.toHaveProperty('keyspace');
  });

  it('builds FRESH policy objects on every call (a policy binds to the first client)', () => {
    const a = buildClientOptions(cfg, { applicationName: 'x' });
    const b = buildClientOptions(cfg, { applicationName: 'x' });
    expect(a.policies?.loadBalancing).toBeDefined();
    expect(a.policies?.loadBalancing).not.toBe(b.policies?.loadBalancing);
    expect(a.policies?.reconnection).not.toBe(b.policies?.reconnection);
    expect(a.policies?.speculativeExecution).not.toBe(b.policies?.speculativeExecution);
  });

  it('adds a plain-text auth provider when credentials are configured', () => {
    const withAuth = cassandraConfig.parse({
      CASSANDRA_USERNAME: 'app',
      CASSANDRA_PASSWORD: 's3cret',
    });
    const options = buildClientOptions(withAuth, { applicationName: 'x' });
    expect(options.authProvider).toBeInstanceOf(auth.PlainTextAuthProvider);
  });

  it('builds client-to-node TLS from the PEM files, never skipping verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cassandra-tls-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const pem = (name: string): string => {
      const path = join(dir, name);
      writeFileSync(path, `-----BEGIN ${name}-----\n`);
      return path;
    };
    const withTls = cassandraConfig.parse({
      CASSANDRA_SSL: 'true',
      CASSANDRA_TLS_CA_PATH: pem('ca.pem'),
      CASSANDRA_TLS_CERT_PATH: pem('client.crt'),
      CASSANDRA_TLS_KEY_PATH: pem('client.key'),
    });
    const { sslOptions } = buildClientOptions(withTls, { applicationName: 'x' });
    expect(sslOptions).toEqual({
      ca: [Buffer.from('-----BEGIN ca.pem-----\n')],
      cert: Buffer.from('-----BEGIN client.crt-----\n'),
      key: Buffer.from('-----BEGIN client.key-----\n'),
      rejectUnauthorized: true,
    });
    // CA only: the client verifies the nodes and presents no certificate.
    const caOnly = cassandraConfig.parse({
      CASSANDRA_SSL: 'true',
      CASSANDRA_TLS_CA_PATH: pem('ca2'),
    });
    expect(buildClientOptions(caOnly, { applicationName: 'x' }).sslOptions).toEqual({
      ca: [Buffer.from('-----BEGIN ca2-----\n')],
      rejectUnauthorized: true,
    });
    expect(buildClientOptions(cfg, { applicationName: 'x' })).not.toHaveProperty('sslOptions');
  });
});

describe('toConsistency', () => {
  it.each(CASSANDRA_CONSISTENCIES)('maps %s onto the driver enum', (name) => {
    expect(toConsistency(name)).toBe(types.consistencies[name]);
  });
});

describe('replication CQL', () => {
  it('renders SimpleStrategy', () => {
    expect(replicationToCql({ class: 'SimpleStrategy', replicationFactor: 3 })).toBe(
      "{'class': 'SimpleStrategy', 'replication_factor': 3}",
    );
  });

  it('renders NetworkTopologyStrategy per data center', () => {
    expect(
      replicationToCql({
        class: 'NetworkTopologyStrategy',
        dataCenters: { 'eu-west-1': 3, dc2: 2 },
      }),
    ).toBe("{'class': 'NetworkTopologyStrategy', 'eu-west-1': 3, 'dc2': 2}");
  });

  it.each([
    [{ class: 'SimpleStrategy', replicationFactor: 0 } as const, /Invalid replication factor 0/],
    [
      { class: 'SimpleStrategy', replicationFactor: 1.5 } as const,
      /Invalid replication factor 1.5/,
    ],
    [{ class: 'NetworkTopologyStrategy', dataCenters: {} } as const, /at least one data center/],
    [
      { class: 'NetworkTopologyStrategy', dataCenters: { "dc'1": 1 } } as const,
      /Invalid data center name/,
    ],
  ])('rejects invalid replication %j', (replication, error) => {
    expect(() => replicationToCql(replication)).toThrow(error);
  });

  it('builds an idempotent CREATE KEYSPACE and refuses unsafe keyspace names', () => {
    expect(createKeyspaceCql('app', { class: 'SimpleStrategy', replicationFactor: 1 })).toBe(
      "CREATE KEYSPACE IF NOT EXISTS app WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1} AND durable_writes = true",
    );
    expect(() =>
      createKeyspaceCql('app; DROP KEYSPACE x', { class: 'SimpleStrategy', replicationFactor: 1 }),
    ).toThrow(/Invalid CQL keyspace/);
  });

  it.each(['app', 'App_2', 'a'.repeat(48)])('accepts identifier %s', (name) => {
    expect(() => assertCqlIdentifier(name)).not.toThrow();
  });

  it.each(['', '1app', 'my-ks', 'a'.repeat(49), '"quoted"'])('rejects identifier %j', (name) => {
    expect(() => assertCqlIdentifier(name)).toThrow(/Invalid CQL identifier/);
  });
});
