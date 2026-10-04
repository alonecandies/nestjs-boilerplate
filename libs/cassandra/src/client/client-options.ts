import type { CassandraConfig, CassandraConsistency } from '@app/config';
import cassandra from 'cassandra-driver';
import { isInteger, map, toPairs } from 'lodash-es';
import { DEFAULT_FETCH_SIZE } from '../cassandra.constants.js';
import type { CassandraReplication } from '../cassandra.types.js';

const { auth, policies, types } = cassandra;

export interface ClientOptionsContext {
  /** Reported to the cluster (`system_views.clients`) — use SERVICE_NAME. */
  applicationName: string;
  /** Bind the client to a keyspace (omit for the keyspace-bootstrap client). */
  keyspace?: string;
}

/** CQL identifiers we interpolate into DDL (keyspace, DC names are validated separately). */
const CQL_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
/** DC names may contain dashes/dots (e.g. `us-east-1`); they are quoted as string literals. */
const DATA_CENTER_NAME = /^[\w.-]{1,64}$/;

/** Maps the config enum (`localQuorum`…) onto the driver's numeric consistency. */
export function toConsistency(name: CassandraConsistency): cassandra.types.consistencies {
  return types.consistencies[name];
}

/**
 * Tuned driver options (research data-libs §2.3). Called once PER CLIENT on purpose: policy
 * instances bind to the first Client that uses them, and a second Client sharing them fails every
 * query with "No connection available" (GOTCHA 14).
 */
export function buildClientOptions(
  cfg: CassandraConfig,
  ctx: ClientOptionsContext,
): cassandra.DseClientOptions {
  return {
    contactPoints: cfg.contactPoints,
    // Must match `nodetool status`, otherwise the driver treats every node as remote/ignored.
    localDataCenter: cfg.localDataCenter,
    ...(ctx.keyspace === undefined ? {} : { keyspace: ctx.keyspace }),
    ...(cfg.credentials === undefined
      ? {}
      : {
          authProvider: new auth.PlainTextAuthProvider(
            cfg.credentials.username,
            cfg.credentials.password,
          ),
        }),
    protocolOptions: { port: cfg.port, maxSchemaAgreementWaitSeconds: 30 },
    pooling: {
      // Protocol v4 multiplexes up to 2048 in-flight requests per connection: a couple of
      // connections per local host saturate a node long before the client becomes the bottleneck.
      coreConnectionsPerHost: {
        [types.distance.local]: cfg.coreConnectionsPerHost,
        [types.distance.remote]: 1,
      },
      maxRequestsPerConnection: 2048,
      heartBeatInterval: 30_000,
    },
    queryOptions: {
      // The driver defaults to prepare:false — we always prepare: server-side statement cache,
      // correct type encoding for bind params and token-aware routing.
      prepare: true,
      consistency: toConsistency(cfg.consistency),
      serialConsistency: types.consistencies.localSerial,
      fetchSize: DEFAULT_FETCH_SIZE,
      // Opt in per query (`isIdempotent: true`) to allow retries / speculative executions.
      isIdempotent: false,
    },
    socketOptions: {
      connectTimeout: 5_000,
      readTimeout: cfg.requestTimeoutMs,
      tcpNoDelay: true,
      keepAlive: true,
    },
    policies: {
      loadBalancing: new policies.loadBalancing.DefaultLoadBalancingPolicy({
        localDc: cfg.localDataCenter,
      }),
      reconnection: new policies.reconnection.ExponentialReconnectionPolicy(1_000, 60_000, false),
      // Only ever used for queries flagged isIdempotent — trims p99 when one replica stalls.
      speculativeExecution: new policies.speculativeExecution.ConstantSpeculativeExecutionPolicy(
        200,
        1,
      ),
    },
    // bigint/varint ⇄ JS BigInt instead of driver Long objects; `undefined` = unset (no tombstone).
    encoding: { useUndefinedAsUnset: true, useBigIntAsLong: true, useBigIntAsVarint: true },
    // DSE Insights reporting: useless RPC noise against Apache Cassandra (GOTCHA 19).
    monitorReporting: { enabled: false },
    applicationName: ctx.applicationName,
  };
}

/** Throws unless `name` is a plain CQL identifier (it gets interpolated into DDL). */
export function assertCqlIdentifier(name: string, what = 'identifier'): void {
  if (!CQL_IDENTIFIER.test(name)) {
    throw new Error(`Invalid CQL ${what} "${name}" (expected [a-zA-Z][a-zA-Z0-9_]*, ≤ 48 chars)`);
  }
}

const assertReplicationFactor = (value: number, where: string): void => {
  if (!isInteger(value) || value < 1) {
    throw new Error(`Invalid replication factor ${value} for ${where} (expected integer ≥ 1)`);
  }
};

/** Renders the `replication` map literal of CREATE/ALTER KEYSPACE (values validated). */
export function replicationToCql(replication: CassandraReplication): string {
  if (replication.class === 'SimpleStrategy') {
    assertReplicationFactor(replication.replicationFactor, 'SimpleStrategy');
    return `{'class': 'SimpleStrategy', 'replication_factor': ${replication.replicationFactor}}`;
  }
  const dataCenters = toPairs(replication.dataCenters);
  if (dataCenters.length === 0) {
    throw new Error('NetworkTopologyStrategy needs at least one data center');
  }
  const entries = map(dataCenters, ([dc, factor]) => {
    if (!DATA_CENTER_NAME.test(dc)) throw new Error(`Invalid data center name "${dc}"`);
    assertReplicationFactor(factor, `data center "${dc}"`);
    return `'${dc}': ${factor}`;
  });
  return `{'class': 'NetworkTopologyStrategy', ${entries.join(', ')}}`;
}

/** `CREATE KEYSPACE IF NOT EXISTS …` — never alters an existing keyspace. */
export function createKeyspaceCql(keyspace: string, replication: CassandraReplication): string {
  assertCqlIdentifier(keyspace, 'keyspace');
  return `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = ${replicationToCql(replication)} AND durable_writes = true`;
}
