import type { ConfigType } from '@nestjs/config';
import { has, isEmpty } from 'lodash-es';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zCsv, zEnum, zInt, zNodeEnv, zPort, zStr } from '../env/env.helpers.js';

const DATA_CENTER_NAME_SOURCE = '[A-Za-z0-9][A-Za-z0-9_.-]{0,63}';

/**
 * A data center name as this repo accepts it: it is quoted into CREATE/ALTER KEYSPACE
 * (`'us-east-1': 3`), so letters, digits, `_`, `.` and `-` only. @platform/cassandra uses the same.
 */
export const CASSANDRA_DATA_CENTER_NAME = new RegExp(`^${DATA_CENTER_NAME_SOURCE}$`);
const DATA_CENTER_ENTRY = new RegExp(`^(${DATA_CENTER_NAME_SOURCE}):([1-9][0-9]{0,2})$`);

/** `dc1:3,dc2:2` → `{ dc1: 3, dc2: 2 }`, parsed once; malformed or repeated names are rejected. */
function zDataCenters(): z.ZodType<Record<string, number>> {
  return zCsv().transform((entries, ctx) => {
    const dataCenters: Record<string, number> = {};
    for (const entry of entries) {
      const [, name, factor] = DATA_CENTER_ENTRY.exec(entry) ?? [];
      if (name === undefined || factor === undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Expected data center:factor pairs such as dc1:3,dc2:3 (names [A-Za-z0-9_.-], factor 1-999)',
        });
        return z.NEVER;
      }
      if (has(dataCenters, name)) {
        ctx.addIssue({ code: 'custom', message: `Data center ${name} is listed twice` });
        return z.NEVER;
      }
      dataCenters[name] = Number(factor);
    }
    return dataCenters;
  });
}

/** Keyspace replication created at boot (@platform/cassandra's `CassandraReplication`). */
export type CassandraReplicationSetting =
  | { class: 'SimpleStrategy'; replicationFactor: number }
  | { class: 'NetworkTopologyStrategy'; dataCenters: Record<string, number> };

function replicationOf(
  dataCenters: Record<string, number>,
  replicationFactor: number,
): CassandraReplicationSetting {
  return isEmpty(dataCenters)
    ? { class: 'SimpleStrategy', replicationFactor }
    : { class: 'NetworkTopologyStrategy', dataCenters };
}

export const CASSANDRA_CONSISTENCIES = ['localOne', 'localQuorum', 'quorum', 'one'] as const;
export type CassandraConsistency = (typeof CASSANDRA_CONSISTENCIES)[number];

export const cassandraEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    CASSANDRA_CONTACT_POINTS: zCsv('localhost', { nonEmpty: true }),
    CASSANDRA_PORT: zPort(9042),
    CASSANDRA_LOCAL_DC: zStr('datacenter1'),
    // Interpolated into CQL (CREATE KEYSPACE / qualified table names) → strict identifier only.
    CASSANDRA_KEYSPACE: zStr('app', {
      pattern: /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
      patternMessage: 'Expected a CQL identifier ([a-zA-Z][a-zA-Z0-9_]*, max 48 chars)',
    }),
    CASSANDRA_USERNAME: zStr(),
    CASSANDRA_PASSWORD: zStr(),
    // Client-to-node TLS. CA = the bundle that signed the nodes' certificates (system roots when
    // unset); CERT + KEY = a client certificate, when the cluster requires one.
    CASSANDRA_SSL: zBool(false),
    CASSANDRA_TLS_CA_PATH: zStr(),
    CASSANDRA_TLS_CERT_PATH: zStr(),
    CASSANDRA_TLS_KEY_PATH: zStr(),
    // SimpleStrategy factor, used only when CASSANDRA_REPLICATION_DATACENTERS is unset.
    CASSANDRA_REPLICATION_FACTOR: zInt(1, { min: 1 }),
    // NetworkTopologyStrategy for the keyspace created at boot: `dc1:3,dc2:3`.
    CASSANDRA_REPLICATION_DATACENTERS: zDataCenters(),
    CASSANDRA_CONSISTENCY: zEnum(CASSANDRA_CONSISTENCIES, 'localOne'),
    CASSANDRA_CORE_CONNECTIONS: zInt(2, { min: 1 }),
    CASSANDRA_REQUEST_TIMEOUT_MS: zInt(12_000, { min: 1 }),
    CASSANDRA_RUN_MIGRATIONS: zBool(true),
    // Production refuses plaintext without it (a mesh encrypts node traffic, or the compose stack).
    CASSANDRA_ALLOW_INSECURE: zBool(false),
    // LOCAL single node only (the compose stack): production refuses SimpleStrategy without it.
    CASSANDRA_ALLOW_SIMPLE_STRATEGY: zBool(false),
  })
  .superRefine((env, ctx) => {
    if ((env.CASSANDRA_USERNAME === undefined) !== (env.CASSANDRA_PASSWORD === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.CASSANDRA_USERNAME === undefined ? 'CASSANDRA_USERNAME' : 'CASSANDRA_PASSWORD'],
        message: 'CASSANDRA_USERNAME and CASSANDRA_PASSWORD must be set together',
      });
    }
    if (
      (env.CASSANDRA_TLS_CERT_PATH === undefined) !==
      (env.CASSANDRA_TLS_KEY_PATH === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: [
          env.CASSANDRA_TLS_CERT_PATH === undefined
            ? 'CASSANDRA_TLS_CERT_PATH'
            : 'CASSANDRA_TLS_KEY_PATH',
        ],
        message: 'CASSANDRA_TLS_CERT_PATH and CASSANDRA_TLS_KEY_PATH must be set together',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env.CASSANDRA_SSL && !env.CASSANDRA_ALLOW_INSECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['CASSANDRA_SSL'],
        message:
          'Cassandra credentials and data would travel unencrypted: set CASSANDRA_SSL=true (and CASSANDRA_TLS_CA_PATH) in production, or CASSANDRA_ALLOW_INSECURE=true when the network layer secures it',
      });
    }
    // Only a process that creates the keyspace (CASSANDRA_RUN_MIGRATIONS) decides its replication.
    if (
      env.CASSANDRA_RUN_MIGRATIONS &&
      isEmpty(env.CASSANDRA_REPLICATION_DATACENTERS) &&
      !env.CASSANDRA_ALLOW_SIMPLE_STRATEGY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CASSANDRA_REPLICATION_DATACENTERS'],
        message:
          'The keyspace would be created with SimpleStrategy (one data center, no rack awareness): set CASSANDRA_REPLICATION_DATACENTERS (e.g. dc1:3) in production, or CASSANDRA_ALLOW_SIMPLE_STRATEGY=true for a local single node',
      });
    }
  })
  .transform((env) => ({
    contactPoints: env.CASSANDRA_CONTACT_POINTS,
    port: env.CASSANDRA_PORT,
    /** Must match `nodetool status` or the driver ignores every node. */
    localDataCenter: env.CASSANDRA_LOCAL_DC,
    keyspace: env.CASSANDRA_KEYSPACE,
    credentials:
      env.CASSANDRA_USERNAME !== undefined && env.CASSANDRA_PASSWORD !== undefined
        ? { username: env.CASSANDRA_USERNAME, password: env.CASSANDRA_PASSWORD }
        : undefined,
    /** Client-to-node TLS (PEM paths); `undefined` = plaintext. */
    tls: env.CASSANDRA_SSL
      ? {
          caPath: env.CASSANDRA_TLS_CA_PATH,
          certPath: env.CASSANDRA_TLS_CERT_PATH,
          keyPath: env.CASSANDRA_TLS_KEY_PATH,
        }
      : undefined,
    /** Replication of the keyspace created at boot (`CREATE KEYSPACE IF NOT EXISTS`). */
    replication: replicationOf(
      env.CASSANDRA_REPLICATION_DATACENTERS,
      env.CASSANDRA_REPLICATION_FACTOR,
    ),
    consistency: env.CASSANDRA_CONSISTENCY,
    coreConnectionsPerHost: env.CASSANDRA_CORE_CONNECTIONS,
    requestTimeoutMs: env.CASSANDRA_REQUEST_TIMEOUT_MS,
    runMigrations: env.CASSANDRA_RUN_MIGRATIONS,
  }));

/** Cassandra (cassandra-driver) cluster, keyspace and pooling. */
export const cassandraConfig = defineConfigNamespace('cassandra', cassandraEnvSchema);
export type CassandraConfig = ConfigType<typeof cassandraConfig>;
