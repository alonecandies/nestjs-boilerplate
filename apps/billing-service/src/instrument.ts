/*
 * Preloaded with `node --import ./dist/instrument.js dist/main.js`: OpenTelemetry must hook the
 * module loader BEFORE Nest, postgres.js, ioredis, kafkajs, grpc-js or the Stripe SDK (undici/http)
 * are imported, so this file imports nothing but the Nest-free `./otel` subpath. No-op unless an
 * OTLP endpoint is configured.
 */
import { startTracing } from '@app/observability/otel';

await startTracing({ serviceName: 'billing-service' });
