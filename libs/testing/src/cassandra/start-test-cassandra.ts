import cassandra from 'cassandra-driver';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** The image compose runs (`docker-compose.yml`, service `cassandra`); a spec pins the two equal. */
export const TEST_CASSANDRA_IMAGE = 'cassandra:5.0.9';
/** The data center of the container; what a client's `localDataCenter` must equal. */
export const TEST_CASSANDRA_DATA_CENTER = 'datacenter1';
/** The keyspace `startTestCassandra` creates when none is given. */
export const TEST_CASSANDRA_DEFAULT_KEYSPACE = 'test';
/** A cold Cassandra 5 node needs 30-90 s to open its CQL port; slower on a busy machine. */
export const TEST_CASSANDRA_STARTUP_TIMEOUT_MS = 180_000;

const CQL_PORT = 9042;
const KEYSPACE = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

export interface TestCassandraOptions {
  /** The keyspace to create (replication factor 1). Default `test`. */
  keyspace?: string;
}

export interface TestCassandra {
  /** `host:port` of the mapped CQL port, ready for a driver's `contactPoints`. */
  readonly contactPoints: string[];
  readonly localDataCenter: string;
  /** The keyspace that exists when `startTestCassandra` resolves. */
  readonly keyspace: string;
  /** Stops the container. Safe to call twice. */
  stop(): Promise<void>;
}

/** Creates the keyspace through a client without one (a keyspace-bound client cannot connect yet). */
async function createKeyspace(contactPoint: string, keyspace: string): Promise<void> {
  const client = new cassandra.Client({
    contactPoints: [contactPoint],
    localDataCenter: TEST_CASSANDRA_DATA_CENTER,
  });
  try {
    await client.connect();
    await client.execute(
      `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
    );
  } finally {
    await client.shutdown();
  }
}

/**
 * A single-node Cassandra for one int spec, with `keyspace` created (SimpleStrategy, RF 1). The
 * node is tuned like the compose service (small G1 heap, no gossip settle wait); the container is
 * ready once it logs that it listens for CQL clients.
 */
export async function startTestCassandra(
  options: TestCassandraOptions = {},
): Promise<TestCassandra> {
  const keyspace = options.keyspace ?? TEST_CASSANDRA_DEFAULT_KEYSPACE;
  if (!KEYSPACE.test(keyspace)) {
    throw new Error(
      `Invalid CQL keyspace "${keyspace}" (expected [a-zA-Z][a-zA-Z0-9_]*, ≤ 48 chars)`,
    );
  }
  const container: StartedTestContainer = await new GenericContainer(TEST_CASSANDRA_IMAGE)
    .withExposedPorts(CQL_PORT)
    .withEnvironment({
      CASSANDRA_DC: TEST_CASSANDRA_DATA_CENTER,
      CASSANDRA_ENDPOINT_SNITCH: 'GossipingPropertyFileSnitch',
      CASSANDRA_NUM_TOKENS: '16',
      MAX_HEAP_SIZE: '512M',
      JVM_EXTRA_OPTS: '-Dcassandra.skip_wait_for_gossip_to_settle=0 -XX:MaxDirectMemorySize=256M',
    })
    .withWaitStrategy(Wait.forLogMessage(/Starting listening for CQL clients/))
    .withStartupTimeout(TEST_CASSANDRA_STARTUP_TIMEOUT_MS)
    .start();
  const contactPoint = `${container.getHost()}:${container.getMappedPort(CQL_PORT)}`;
  try {
    await createKeyspace(contactPoint, keyspace);
  } catch (error) {
    await container.stop();
    throw error;
  }
  let stopped = false;
  return {
    contactPoints: [contactPoint],
    localDataCenter: TEST_CASSANDRA_DATA_CENTER,
    keyspace,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await container.stop();
    },
  };
}
