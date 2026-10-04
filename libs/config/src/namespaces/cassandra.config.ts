import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zCsv, zEnum, zInt, zPort, zStr } from '../env/env.helpers.js';

export const CASSANDRA_CONSISTENCIES = ['localOne', 'localQuorum', 'quorum', 'one'] as const;
export type CassandraConsistency = (typeof CASSANDRA_CONSISTENCIES)[number];

export const cassandraEnvSchema = z
  .object({
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
    CASSANDRA_REPLICATION_FACTOR: zInt(1, { min: 1 }),
    CASSANDRA_CONSISTENCY: zEnum(CASSANDRA_CONSISTENCIES, 'localOne'),
    CASSANDRA_CORE_CONNECTIONS: zInt(2, { min: 1 }),
    CASSANDRA_REQUEST_TIMEOUT_MS: zInt(12_000, { min: 1 }),
    CASSANDRA_RUN_MIGRATIONS: zBool(true),
  })
  .superRefine((env, ctx) => {
    if ((env.CASSANDRA_USERNAME === undefined) !== (env.CASSANDRA_PASSWORD === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.CASSANDRA_USERNAME === undefined ? 'CASSANDRA_USERNAME' : 'CASSANDRA_PASSWORD'],
        message: 'CASSANDRA_USERNAME and CASSANDRA_PASSWORD must be set together',
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
    replicationFactor: env.CASSANDRA_REPLICATION_FACTOR,
    consistency: env.CASSANDRA_CONSISTENCY,
    coreConnectionsPerHost: env.CASSANDRA_CORE_CONNECTIONS,
    requestTimeoutMs: env.CASSANDRA_REQUEST_TIMEOUT_MS,
    runMigrations: env.CASSANDRA_RUN_MIGRATIONS,
  }));

/** Cassandra (cassandra-driver) cluster, keyspace and pooling. */
export const cassandraConfig = defineConfigNamespace('cassandra', cassandraEnvSchema);
export type CassandraConfig = ConfigType<typeof cassandraConfig>;
