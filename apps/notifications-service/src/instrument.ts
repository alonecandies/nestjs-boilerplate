/*
 * Preloaded with `node --import ./dist/instrument.js dist/main.js`: OpenTelemetry must hook the
 * module loader BEFORE Nest, cassandra-driver, ioredis, bullmq, kafkajs or grpc-js are imported,
 * so this file imports nothing but the Nest-free `./otel` subpath. No-op unless an OTLP endpoint
 * is configured.
 */
import { startTracing } from '@app/observability/otel';

await startTracing({ serviceName: 'notifications-service' });
