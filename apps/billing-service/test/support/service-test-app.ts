import { ledgerConfig } from '@domain/billing';
import type { CustomTransportStrategy } from '@nestjs/microservices';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { buildFastifyOptions, configureHttpApp } from '@platform/bootstrap';
import { appConfig } from '@platform/config';
import type { GrpcPackageSpec } from '@platform/contracts';
import { createFastifyTestApp } from '@platform/testing';
import { connectGrpcServer, type connectKafkaConsumer } from '@platform/transport';
import { connectLedgerConsumer } from '../../src/ledger-consumer.js';

export interface ServiceTestAppOptions {
  /** gRPC packages served on `GRPC_URL` (like `connectGrpcServer` in main.ts). */
  grpc: readonly GrpcPackageSpec[];
  /**
   * In-process replacement for the broker behind `connectKafkaConsumer`: main.ts's consumer wiring
   * (`connectLedgerConsumer`, on the same `LEDGER_ENABLED`) runs as in production, but connects
   * this strategy instead of a `ServerKafka`, with the same `inheritAppConfig: true`, so consumers
   * see exactly the enhancers they get in production. Required when that wiring connects one.
   */
  kafka?: CustomTransportStrategy;
  /** Receives the options main.ts passes to `connectKafkaConsumer` (its consumer group). */
  onKafkaConsumer?: (options: Parameters<typeof connectKafkaConsumer>[1]) => void;
}

/**
 * Boots the service the way `main.ts` does — `createServiceApp` wiring → transports (gRPC, and the
 * ledger-posting consumer while `LEDGER_ENABLED=true`) →
 * `startAllMicroservices` — but from a `TestingModule`, so network-edge providers can be
 * overridden with fakes. HTTP is exercised with `app.inject()` (no port bound); the gRPC server
 * really listens on `GRPC_URL`. Close it with `app.close()`.
 */
export async function startServiceTestApp(
  builder: TestingModuleBuilder,
  options: ServiceTestAppOptions,
): Promise<NestFastifyApplication> {
  const config = appConfig.parse();
  const app = await createFastifyTestApp(
    builder,
    async (created) => {
      // = createServiceApp (no CORS/cookies/raw body/multipart). Signal hooks stay off: the test
      // closes the app itself, and several apps may share one process.
      await configureHttpApp(created, {
        config,
        cors: false,
        cookies: false,
        shutdownHooks: false,
      });
      connectGrpcServer(created, options.grpc);
      connectLedgerConsumer(created, ledgerConfig.parse(), (target, kafkaOptions) => {
        options.onKafkaConsumer?.(kafkaOptions);
        if (options.kafka === undefined) {
          throw new Error('main.ts connects a Kafka consumer here: pass `kafka` to the harness');
        }
        return target.connectMicroservice({ strategy: options.kafka }, { inheritAppConfig: true });
      });
    },
    { adapter: new FastifyAdapter(buildFastifyOptions(config)), appOptions: { bufferLogs: true } },
  );
  await app.startAllMicroservices();
  return app;
}
