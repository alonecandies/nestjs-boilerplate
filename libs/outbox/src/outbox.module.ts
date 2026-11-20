import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  type DatabaseConfig,
  databaseConfig,
  type OutboxConfig,
  outboxConfig,
} from '@platform/config';
import { type DrizzleTransactionHost, TransactionHost } from '@platform/database';
import { DistributedLockService } from '@platform/redis';
import { KafkaProducer } from '@platform/transport';
import type { OutboxSystemRepository } from './outbox.system-repository.js';
import type { OutboxFeature } from './outbox.types.js';
import { OutboxRelay } from './outbox-relay.js';
import type { OutboxWriter } from './outbox-writer.js';

export interface OutboxFeatureOptions {
  /** The domain's outbox: `name` (its Postgres schema) names the relay lock and log context. */
  readonly feature: OutboxFeature;
  /** The domain's `OutboxWriter` subclass (`class OrdersOutbox extends OutboxWriter {}`): the DI token. */
  readonly writer: Type<OutboxWriter>;
  /** The domain's `OutboxSystemRepository` subclass (in its `*.system-repository.ts`). */
  readonly systemRepository: Type<OutboxSystemRepository>;
}

/** The (unexported) provider token of the relay of the outbox `name`. */
export const outboxRelayToken = (name: string): string => `OutboxRelay:${name}`;

/**
 * One outbox of a domain: `OutboxModule.forFeature({ feature, writer, systemRepository })` provides
 * and exports the writer (built over the CLS `TransactionHost` and `KafkaProducer`) and the system
 * repository, and owns one `OutboxRelay`, which starts on application bootstrap when
 * `OUTBOX_RELAY_ENABLED` and DATABASE_SYSTEM_URL is set (one warning otherwise) and stops before
 * the clients close. Each call is its own module instance, so a process may own several outboxes.
 *
 * Needs the root module's global `DatabaseModule` (transactions, the system pool),
 * `KafkaProducerModule` and `RedisModule` (`DistributedLockService`).
 */
@Module({})
export class OutboxModule {
  static forFeature(options: OutboxFeatureOptions): DynamicModule {
    const { feature, writer, systemRepository } = options;
    const relayToken = outboxRelayToken(feature.name);
    return {
      module: OutboxModule,
      imports: [ConfigModule.forFeature(outboxConfig), ConfigModule.forFeature(databaseConfig)],
      providers: [
        systemRepository,
        {
          provide: writer,
          inject: [TransactionHost, KafkaProducer],
          useFactory: (txHost: DrizzleTransactionHost, kafka: KafkaProducer): OutboxWriter =>
            new writer(feature, txHost, kafka),
        },
        {
          provide: relayToken,
          inject: [
            systemRepository,
            KafkaProducer,
            DistributedLockService,
            outboxConfig.KEY,
            databaseConfig.KEY,
          ],
          useFactory: (
            repository: OutboxSystemRepository,
            kafka: KafkaProducer,
            locks: DistributedLockService,
            config: OutboxConfig,
            database: DatabaseConfig,
          ): OutboxRelay =>
            new OutboxRelay(feature, repository, kafka, locks, config, {
              systemPool: database.systemUrl !== undefined,
            }),
        },
      ],
      exports: [writer, systemRepository],
    };
  }
}
