import 'reflect-metadata';
import {
  createHttpApp,
  installProcessHandlers,
  listen,
  runClustered,
  setupApiDocs,
} from '@app/bootstrap';
import { appConfig } from '@app/config';
import { flushLogs } from '@app/observability';
import { createRedisIoAdapter } from '@app/redis';
import { connectKafkaConsumer } from '@app/transport';
import { Logger } from '@nestjs/common';
import { GATEWAY_API_DOCS } from './app.constants.js';
import { AppModule } from './app.module.js';
import { gatewayConfig } from './gateway.config.js';

const logger = new Logger('Bootstrap');

/**
 * One gateway process (or cluster worker): HTTP (REST + GraphQL + Socket.IO) and, as a hybrid
 * app, the Kafka push consumer.
 */
async function bootstrap(): Promise<void> {
  // First, so the Nest create phase is covered too: uncaught errors → fatal log + exit 1, and the
  // forced-exit deadline of a graceful shutdown (createHttpApp's own call is then a no-op). Here,
  // not at module level: a cluster primary must not arm the timer ahead of its SIGKILL deadline.
  installProcessHandlers(undefined, { shutdownTimeoutMs: appConfig.parse().shutdownTimeoutMs });
  // rawBody: the Stripe webhook bytes are forwarded to billing-service, which verifies the
  // signature over them. multipart: bounded @fastify/multipart for the streaming file upload.
  const app = await createHttpApp(AppModule, { rawBody: true, multipart: true });
  try {
    // Socket.IO over the Redis adapter: an emit to `user:{id}` reaches every replica.
    app.useWebSocketAdapter(await createRedisIoAdapter(app));
    // notification-created → WebSocket room + GraphQL subscription. `inheritAppConfig` makes the
    // global enhancers (cls, pipes, filter) apply to the consumer too.
    connectKafkaConsumer(app, { groupId: gatewayConfig.parse().kafkaGroupId });
    setupApiDocs(app, GATEWAY_API_DOCS);
    await app.startAllMicroservices();
    await listen(app);
  } catch (error) {
    // Close what init already opened (Redis, gRPC channels, Kafka, sockets) before exiting.
    await app.close().catch(() => undefined);
    throw error;
  }
}

try {
  await runClustered(bootstrap);
} catch (error) {
  // Boot failed (invalid env, unreachable Redis, port in use…): one fatal line, then a non-zero
  // exit so the orchestrator restarts / reports it. The Error carries the original as `cause`:
  // pino logs a structured `err`; the console logger (still active when Nest failed before
  // `useLogger`) prints both stacks. Exit explicitly: providers created before the failure may
  // still hold sockets that would keep the process alive.
  const message = error instanceof Error ? error.message : String(error);
  logger.fatal(new Error(`Gateway failed to start: ${message}`, { cause: error }));
  await flushLogs();
  process.exit(1);
}
