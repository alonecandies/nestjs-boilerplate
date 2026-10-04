import { withTimeout } from '@app/common';
import { type AppConfig, appConfig, type RedisConfig, redisConfig } from '@app/config';
import { createRedisClient } from '@app/redis';
import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisPubSub } from 'graphql-redis-subscriptions';
import { PubSub } from 'graphql-subscriptions';
import type { Redis } from 'ioredis';
import { GRAPHQL_PUB_SUB, type GraphqlPubSub } from './pubsub.constants.js';

export interface GraphqlPubSubModuleOptions {
  /**
   * Use the in-process `PubSub` from graphql-subscriptions instead of Redis. This is for tests
   * and single-process demos only: events never reach other replicas.
   */
  inMemory?: boolean;
}

const PUB_SUB_OPTIONS = Symbol('GRAPHQL_PUB_SUB_OPTIONS');
const CLOSE_TIMEOUT_MS = 2_000;

/**
 * RedisPubSub on two dedicated connections. SUBSCRIBE puts a connection in subscriber mode,
 * where it can't run other commands, so it can't share the app's `REDIS_CLIENT`. Both connections
 * have `maxRetriesPerRequest: null`: a publish during a Redis blip waits for the reconnect
 * instead of failing the mutation that triggered it.
 */
export function createRedisPubSub(cfg: RedisConfig, connectionName: string): RedisPubSub {
  return new RedisPubSub({
    publisher: createRedisClient(cfg, {
      connectionName: `${connectionName}:gql-pub`,
      maxRetriesPerRequest: null,
    }),
    subscriber: createRedisClient(cfg, {
      connectionName: `${connectionName}:gql-sub`,
      maxRetriesPerRequest: null,
      enableAutoPipelining: false,
    }),
  });
}

/** Closes the PubSub's Redis connections on shutdown (QUIT, bounded, then hard disconnect). */
@Injectable()
export class GraphqlPubSubShutdown implements OnApplicationShutdown {
  private readonly logger = new Logger(GraphqlPubSubShutdown.name);

  constructor(@Inject(GRAPHQL_PUB_SUB) private readonly pubSub: GraphqlPubSub) {}

  async onApplicationShutdown(): Promise<void> {
    if (!(this.pubSub instanceof RedisPubSub)) return;
    const clients = [this.pubSub.getSubscriber(), this.pubSub.getPublisher()] as Redis[];
    await Promise.all(
      clients.map(async (client) => {
        if (client.status === 'end') return;
        try {
          await withTimeout(client.quit(), CLOSE_TIMEOUT_MS, 'Redis QUIT timed out');
        } catch (error) {
          this.logger.warn(
            `Forcing PubSub connection close: ${error instanceof Error ? error.message : 'unknown'}`,
          );
          client.disconnect();
        }
      }),
    );
  }
}

/**
 * Global GraphQL PubSub (`GRAPHQL_PUB_SUB`, `@InjectPubSub()`). It is backed by Redis, so an event
 * published on one replica reaches subscribers connected to any replica. Import it once, either as
 * the class (`GraphqlPubSubModule`, Redis) or through `forRootAsync(options)`. The dynamic form
 * only overrides the options provider.
 */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [
    { provide: PUB_SUB_OPTIONS, useValue: {} satisfies GraphqlPubSubModuleOptions },
    {
      provide: GRAPHQL_PUB_SUB,
      inject: [PUB_SUB_OPTIONS, redisConfig.KEY, { token: appConfig.KEY, optional: true }],
      useFactory: (
        options: GraphqlPubSubModuleOptions,
        redis: RedisConfig,
        app: AppConfig | undefined,
      ): GraphqlPubSub =>
        options.inMemory
          ? new PubSub()
          : createRedisPubSub(redis, app?.serviceName ?? redis.keyPrefix),
    },
    GraphqlPubSubShutdown,
  ],
  exports: [GRAPHQL_PUB_SUB],
})
export class GraphqlPubSubModule {
  static forRootAsync(options: GraphqlPubSubModuleOptions = {}): DynamicModule {
    // Dynamic metadata is applied after the static metadata, so this provider replaces the
    // default options.
    return {
      module: GraphqlPubSubModule,
      global: true,
      providers: [{ provide: PUB_SUB_OPTIONS, useValue: options }],
    };
  }
}
