import { type GrpcConfig, grpcConfig, type KafkaConfig, kafkaConfig } from '@app/config';
import type { GrpcPackageName } from '@app/contracts';
import type { INestApplication, INestApplicationContext, INestMicroservice } from '@nestjs/common';
import type { CustomStrategy, KafkaOptions } from '@nestjs/microservices';
import {
  createGrpcServerStrategy,
  type GrpcServerOptionsExtras,
} from '../grpc/grpc-server.options.js';
import { createKafkaServerOptions, type KafkaServerOptionsExtras } from '../kafka/kafka.options.js';

interface ConfigNamespaceLike<T> {
  readonly KEY: string | symbol;
  parse(): T;
}

/**
 * The namespace value from the app container when some module loaded it
 * (`ConfigModule.forFeature`), else parsed from the environment with the same schema. A gRPC-only
 * service may never inject `grpcConfig` anywhere except here.
 */
function resolveConfig<T>(app: INestApplicationContext, namespace: ConfigNamespaceLike<T>): T {
  try {
    return app.get<T, T>(namespace.KEY, { strict: false });
  } catch {
    return namespace.parse();
  }
}

/**
 * Attaches the gRPC server for `packages` to a hybrid (HTTP + gRPC) app, configured from
 * `grpcConfig`, with `grpc.health.v1` (SERVING once listening, NOT_SERVING on close) and server
 * reflection.
 *
 * `inheritAppConfig: true` makes global enhancers (`APP_*`, nestjs-cls, metrics) reach gRPC
 * handlers too, which is why every global enhancer must branch on `context.getType()`. Call it
 * AFTER every `app.useGlobal*()` call and BEFORE `app.startAllMicroservices()`.
 */
export function connectGrpcServer(
  app: INestApplication,
  packages: readonly GrpcPackageName[],
  extras: GrpcServerOptionsExtras = {},
): INestMicroservice {
  const cfg = resolveConfig<GrpcConfig>(app, grpcConfig);
  return app.connectMicroservice<CustomStrategy>(createGrpcServerStrategy(cfg, packages, extras), {
    inheritAppConfig: true,
  });
}

/**
 * Attaches a Kafka consumer (consumer group `groupId`, default `kafkaConfig.groupId`) to a hybrid
 * app. Handlers are `@KafkaEventPattern()` methods on `@KafkaConsumerController()` controllers.
 * Same `inheritAppConfig` and ordering rules as `connectGrpcServer`. Every subscribed topic must
 * exist, because auto-creation is off.
 */
export function connectKafkaConsumer(
  app: INestApplication,
  options: KafkaServerOptionsExtras = {},
): INestMicroservice {
  const cfg = resolveConfig<KafkaConfig>(app, kafkaConfig);
  return app.connectMicroservice<KafkaOptions>(createKafkaServerOptions(cfg, options), {
    inheritAppConfig: true,
  });
}
