/**
 * @platform/transport/testing — test doubles for code that publishes Kafka events. Not imported by
 * production code (a separate subpath, so it never lands in a service's module graph).
 */
export {
  FakeKafkaProducer,
  type PublishedKafkaRecord,
} from '../kafka/testing/fake-kafka-producer.js';
