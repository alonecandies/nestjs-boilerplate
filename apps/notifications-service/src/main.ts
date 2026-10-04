import 'reflect-metadata';
import { createServiceApp, listen } from '@app/bootstrap';
import { withTimeout } from '@app/common';
import { flushLogs } from '@app/observability';
import { connectGrpcServer, connectKafkaConsumer } from '@app/transport';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { NOTIFICATIONS_CONSUMER_GROUP } from './notifications-service.constants.js';

/** Upper bound for releasing what a failed boot already opened (pools, sockets, consumers). */
const FAILED_BOOT_CLOSE_TIMEOUT_MS = 5_000;

const logger = new Logger('Bootstrap');
let app: NestFastifyApplication | undefined;

try {
  // HTTP (PORT, default 3002 via .env) serves only /health/* and /metrics. createServiceApp also
  // installs the process safety nets and SIGTERM/SIGINT → graceful shutdown: gRPC health
  // NOT_SERVING → HTTP + gRPC drain, the Kafka consumer finishes its in-flight messages and
  // leaves the group → Cassandra/Redis/Kafka producer closed → exit 0, bounded by
  // SHUTDOWN_TIMEOUT_MS.
  app = await createServiceApp(AppModule);
  // Both transports after every global enhancer is known (inheritAppConfig), before
  // startAllMicroservices. The topics (and their .dlq) must exist: auto-creation is off.
  connectGrpcServer(app, ['notifications']);
  connectKafkaConsumer(app, { groupId: NOTIFICATIONS_CONSUMER_GROUP });
  await app.startAllMicroservices();
  // Last: the HTTP port (readiness probes) only opens once gRPC and the consumer are up.
  await listen(app);
} catch (error) {
  // Fail fast: a service that cannot reach its dependencies must not look healthy. The
  // orchestrator restarts it with backoff. (The Error itself: pino keeps it as `err` + stack.)
  logger.fatal(error);
  await withTimeout(app?.close() ?? Promise.resolve(), FAILED_BOOT_CLOSE_TIMEOUT_MS).catch(
    () => undefined,
  );
  await flushLogs();
  process.exit(1);
}
