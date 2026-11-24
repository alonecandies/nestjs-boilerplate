import type { INestApplication, INestApplicationContext, INestMicroservice } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CustomStrategy } from '@nestjs/microservices';
import { type GrpcConfig, grpcConfig, type KafkaConfig, kafkaConfig } from '@platform/config';
import type { GrpcPackageSpec } from '@platform/contracts';
import { applyPrincipalAssertionConfig } from '../grpc/grpc-principal-assertion.js';
import {
  createGrpcServerStrategy,
  type GrpcServerOptionsExtras,
} from '../grpc/grpc-server.options.js';
import { InstrumentedServerKafka } from '../kafka/instrumented-server-kafka.js';
import { createKafkaServerOptions, type KafkaServerOptionsExtras } from '../kafka/kafka.options.js';

interface ConfigNamespaceLike<T> {
  /** The `registerAs` token, which is also the key `ConfigModule.forFeature` merges the value under. */
  readonly namespace: string;
  parse(): T;
}

/**
 * The namespace value from the app container when some module loaded it
 * (`ConfigModule.forFeature`), else parsed from the environment with the same schema. A gRPC-only
 * service may never inject `grpcConfig` anywhere except here.
 *
 * It never probes `app.get(namespace.KEY)`: on a `NestFactory` app every method runs in Nest's
 * exception zone, which logs a miss (`UnknownElementException: Nest could not find
 * CONFIGURATION(kafka)`) at ERROR before rethrowing, so a normal fallback looked like a boot
 * failure. `ConfigService.get(namespace)` returns the merged value, or `undefined`, without
 * throwing. `ConfigService` exists in every app that uses `@platform/config`; the catch only covers a
 * bare context without it.
 */
function resolveConfig<T extends object>(
  app: INestApplicationContext,
  namespace: ConfigNamespaceLike<T>,
): T {
  let loaded: unknown;
  try {
    loaded = app.get(ConfigService, { strict: false }).get<unknown>(namespace.namespace);
  } catch {
    loaded = undefined;
  }
  // An object only: ConfigService falls back to `process.env[namespace]`, which is a string.
  return typeof loaded === 'object' && loaded !== null ? (loaded as T) : namespace.parse();
}

/**
 * Attaches the gRPC server for `packages` to a hybrid (HTTP + gRPC) app, configured from
 * `grpcConfig`, with `grpc.health.v1` (SERVING once listening, NOT_SERVING on close) and server
 * reflection. It first builds the principal assertion settings the server verifies with from that
 * same namespace (`applyPrincipalAssertionConfig`), so a bad key stops the boot here, before
 * anything listens, instead of failing the first call.
 *
 * `inheritAppConfig: true` makes global enhancers (`APP_*`, nestjs-cls, metrics) reach gRPC
 * handlers too, which is why every global enhancer must branch on `context.getType()`. Call it
 * AFTER every `app.useGlobal*()` call and BEFORE `app.startAllMicroservices()`.
 */
export function connectGrpcServer(
  app: INestApplication,
  packages: readonly GrpcPackageSpec[],
  extras: GrpcServerOptionsExtras = {},
): INestMicroservice {
  const cfg = resolveConfig<GrpcConfig>(app, grpcConfig);
  applyPrincipalAssertionConfig(cfg.principalAssertion);
  return app.connectMicroservice<CustomStrategy>(createGrpcServerStrategy(cfg, packages, extras), {
    inheritAppConfig: true,
  });
}

/**
 * Attaches a Kafka consumer (consumer group `groupId`, default `kafkaConfig.groupId`) to a hybrid
 * app. Handlers are `@KafkaEventPattern()` methods on `@KafkaConsumerController()` controllers.
 * Same `inheritAppConfig` and ordering rules as `connectGrpcServer`. Every subscribed topic must
 * exist, because auto-creation is off. It connects `InstrumentedServerKafka` (Nest's Kafka server plus the
 * `kafka_consumer_lag` gauge) as a custom strategy; `transportId` stays `Transport.KAFKA`.
 */
export function connectKafkaConsumer(
  app: INestApplication,
  options: KafkaServerOptionsExtras = {},
): INestMicroservice {
  const cfg = resolveConfig<KafkaConfig>(app, kafkaConfig);
  const { options: kafkaOptions } = createKafkaServerOptions(cfg, options);
  return app.connectMicroservice<CustomStrategy>(
    { strategy: new InstrumentedServerKafka(kafkaOptions) },
    { inheritAppConfig: true },
  );
}
