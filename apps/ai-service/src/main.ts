import 'reflect-metadata';
import { AI_GRPC_PACKAGE } from '@domain/ai-contracts';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServiceApp, listen, listenMetrics } from '@platform/bootstrap';
import { withTimeout } from '@platform/common';
import { flushLogs } from '@platform/observability';
import { connectGrpcServer } from '@platform/transport';
import { AppModule } from './app.module.js';

/** Upper bound for releasing what a failed boot already opened (pools, sockets). */
const FAILED_BOOT_CLOSE_TIMEOUT_MS = 5_000;

const logger = new Logger('Bootstrap');
let app: NestFastifyApplication | undefined;

try {
  // HTTP (PORT, default 3004 via .env) serves only /health/* (/metrics: METRICS_PORT).
  // createServiceApp also installs the process safety nets and SIGTERM/SIGINT → graceful
  // shutdown: gRPC health NOT_SERVING → HTTP + gRPC drain (a streamed turn in flight is cancelled
  // when its call ends, and its reply so far is stored) → Postgres closed → exit 0, bounded by
  // SHUTDOWN_TIMEOUT_MS.
  app = await createServiceApp(AppModule);
  // After every global enhancer is known (inheritAppConfig) and before startAllMicroservices.
  connectGrpcServer(app, [AI_GRPC_PACKAGE]);
  await app.startAllMicroservices();
  // Last: the HTTP port (readiness probes) only opens once gRPC accepts calls.
  await listenMetrics(app);
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
