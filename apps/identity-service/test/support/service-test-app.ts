import { buildFastifyOptions, configureHttpApp } from '@app/bootstrap';
import { appConfig } from '@app/config';
import type { GrpcPackageName } from '@app/contracts';
import { createFastifyTestApp } from '@app/testing';
import { connectGrpcServer } from '@app/transport';
import type { CustomTransportStrategy } from '@nestjs/microservices';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModuleBuilder } from '@nestjs/testing';

export interface ServiceTestAppOptions {
  /** gRPC packages served on `GRPC_URL` (like `connectGrpcServer` in main.ts). */
  grpc: readonly GrpcPackageName[];
  /**
   * In-process replacement for `connectKafkaConsumer` (no broker): connected with the same
   * `inheritAppConfig: true`, so consumers see exactly the enhancers they get in production.
   */
  kafka?: CustomTransportStrategy;
}

/**
 * Boots the service the way `main.ts` does — `createServiceApp` wiring → transports →
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
      if (options.kafka) {
        created.connectMicroservice({ strategy: options.kafka }, { inheritAppConfig: true });
      }
    },
    { adapter: new FastifyAdapter(buildFastifyOptions(config)), appOptions: { bufferLogs: true } },
  );
  await app.startAllMicroservices();
  return app;
}
