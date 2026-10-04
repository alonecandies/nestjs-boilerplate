import 'reflect-metadata';
import { createServiceApp, listen } from '@app/bootstrap';
import { withTimeout } from '@app/common';
import { flushLogs } from '@app/observability';
import { connectGrpcServer } from '@app/transport';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

/** Upper bound for releasing what a failed boot already opened (pools, sockets). */
const FAILED_BOOT_CLOSE_TIMEOUT_MS = 5_000;

const logger = new Logger('Bootstrap');
let app: NestFastifyApplication | undefined;

try {
  // HTTP (PORT, default 3003 via .env) serves only /health/* and /metrics: the Stripe webhook is
  // received by the gateway (raw body) and forwarded over gRPC, so no raw-body parser here.
  // createServiceApp also installs the process safety nets and SIGTERM/SIGINT → graceful
  // shutdown: gRPC health NOT_SERVING → HTTP + gRPC drain (an in-flight webhook transaction
  // commits) → Postgres/Redis/Kafka closed → exit 0, bounded by SHUTDOWN_TIMEOUT_MS.
  app = await createServiceApp(AppModule);
  // After every global enhancer is known (inheritAppConfig) and before startAllMicroservices.
  connectGrpcServer(app, ['billing']);
  await app.startAllMicroservices();
  // Last: the HTTP port (readiness probes) only opens once gRPC accepts calls.
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
