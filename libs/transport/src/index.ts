/**
 * @app/transport — gRPC and Kafka infrastructure shared by every service:
 * - gRPC: server/client options (health, reflection, service config with deadlines, retries and
 *   round_robin, keepalive), `GrpcClientsModule`, `grpcCall` + circuit breakers, status mapping
 *   (DomainException <-> gRPC <-> HTTP), metadata helpers, `@GrpcController()`, zod payload pipe.
 * - Kafka: server/client options, `KafkaProducerModule` / `KafkaProducer` (validated envelopes),
 *   `FakeKafkaProducer`, `@KafkaEventPattern()`, `ParseEventEnvelopePipe`, `KafkaDeadLetterFilter`,
 *   `@KafkaConsumerController()`, `KafkaHealthIndicator`.
 * - Hybrid apps: `connectGrpcServer` / `connectKafkaConsumer` (`inheritAppConfig: true`).
 */
export * from './context/transport-context.js';
export * from './grpc/domain-to-grpc-exception.filter.js';
export * from './grpc/grpc.constants.js';
export * from './grpc/grpc-call.js';
export * from './grpc/grpc-caller-context.js';
export * from './grpc/grpc-circuit-breakers.js';
export * from './grpc/grpc-client.options.js';
export * from './grpc/grpc-clients.module.js';
export * from './grpc/grpc-context.interceptor.js';
export * from './grpc/grpc-controller.decorator.js';
export * from './grpc/grpc-health.js';
export * from './grpc/grpc-metadata.js';
export * from './grpc/grpc-server.options.js';
export * from './grpc/grpc-status.mapping.js';
export * from './grpc/grpc-tls.js';
export * from './grpc/rpc-status.exception.js';
export * from './grpc/zod-rpc-validation.pipe.js';
export * from './hybrid/connect-microservices.js';
export * from './kafka/dead-letter.js';
export * from './kafka/dead-letter-replay.js';
export * from './kafka/kafka.constants.js';
export * from './kafka/kafka.errors.js';
export * from './kafka/kafka.health.js';
export * from './kafka/kafka.options.js';
export * from './kafka/kafka-consumer.decorator.js';
export * from './kafka/kafka-context.interceptor.js';
export * from './kafka/kafka-dead-letter.filter.js';
export * from './kafka/kafka-event-pattern.decorator.js';
export * from './kafka/kafka-logger.js';
export * from './kafka/kafka-producer.module.js';
export * from './kafka/kafka-producer.service.js';
export * from './kafka/kafka-retry.interceptor.js';
export * from './kafka/parse-event-envelope.pipe.js';
export * from './kafka/testing/fake-kafka-producer.js';
