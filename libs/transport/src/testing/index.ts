/**
 * @platform/transport/testing — test doubles for code that publishes Kafka events, and a throwaway
 * edge key pair that signs gRPC principal assertions. Not imported by production code (a separate
 * subpath, so it never lands in a service's module graph).
 */
export {
  FakeKafkaProducer,
  type PublishedKafkaRecord,
} from '../kafka/testing/fake-kafka-producer.js';
export {
  createTestPrincipalSigner,
  type TestPrincipalSigner,
  type TestPrincipalSignOptions,
} from './test-principal-signer.js';
