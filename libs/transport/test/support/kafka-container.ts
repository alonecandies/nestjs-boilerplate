import { createServer } from 'node:net';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * The broker of the `transport:int` specs: the image of docker-compose.yml's `kafka` service and of
 * `libs/outbox/test/outbox-kafka-delivery.int-spec.ts` (scripts/int-images.spec.ts checks they
 * match, and the CI integration job pre-pulls it).
 */
export const TRANSPORT_KAFKA_IMAGE = 'apache/kafka:4.3.1';

export interface StartedKafka {
  readonly container: StartedTestContainer;
  /** `127.0.0.1:<port>`, the broker's advertised external address. */
  readonly broker: string;
}

/**
 * A free loopback port, chosen before the container starts: the broker must advertise the host
 * port its clients connect to, and Docker picks a random one only after the container is created.
 */
async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no free port');
  return address.port;
}

/** A single-node KRaft broker whose advertised external address is the mapped host port. */
export async function startKafka(): Promise<StartedKafka> {
  const port = await freeLoopbackPort();
  const broker = `127.0.0.1:${port}`;
  const container = await new GenericContainer(TRANSPORT_KAFKA_IMAGE)
    .withExposedPorts({ container: 9094, host: port })
    .withEnvironment({
      CLUSTER_ID: '5L6g3nShT-eMCtK--X86sw',
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:9094',
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:9092,EXTERNAL://${broker}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@127.0.0.1:9093',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_DEFAULT_REPLICATION_FACTOR: '1',
      KAFKA_NUM_PARTITIONS: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(180_000)
    .start();
  return { container, broker };
}
