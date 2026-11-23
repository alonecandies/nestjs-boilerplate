import { type INestApplicationContext, Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  InjectSystemDatabase,
  SYSTEM_DATABASE,
  SystemDatabase,
  TransactionHost,
} from '@platform/database';
import type { LockResult } from '@platform/redis';
import { DistributedLockService } from '@platform/redis';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecordingDrizzle,
  createRlsTransactionHost,
  FX_OUTBOX,
  FxOutboxSystemRepository,
  fxOutbox,
} from '../test/outbox-fixture.js';
import { OutboxModule, outboxRelayToken } from './outbox.module.js';
import { OutboxSystemRepository } from './outbox.system-repository.js';
import type { OutboxFeature } from './outbox.types.js';
import { OutboxRelay } from './outbox-relay.js';
import { OutboxWriter } from './outbox-writer.js';

/** A second outbox (the same column set; only the name matters to the module). */
const FY_OUTBOX: OutboxFeature = { name: 'fy', table: fxOutbox };

class FxOutbox extends OutboxWriter {}
class FyOutbox extends OutboxWriter {}

@Injectable()
class FyOutboxSystemRepository extends OutboxSystemRepository {
  constructor(@InjectSystemDatabase() system: SystemDatabase) {
    super(FY_OUTBOX, system);
  }
}

/** Records the lock resources asked for; never grants one (the relays stay followers). */
class RecordingLock {
  readonly resources: string[] = [];

  async using<T>(resource: string): Promise<LockResult<T>> {
    this.resources.push(resource);
    return { acquired: false, reason: 'held' };
  }
}

const lock = new RecordingLock();

/** What the apps' root modules provide globally (database, CLS transactions, Kafka, Redis). */
@Module({
  providers: [
    { provide: SYSTEM_DATABASE, useValue: new SystemDatabase(null) },
    { provide: TransactionHost, useValue: createRlsTransactionHost(createRecordingDrizzle().db) },
    { provide: KafkaProducer, useValue: new FakeKafkaProducer({ source: 'fx-service' }) },
    { provide: DistributedLockService, useValue: lock },
  ],
  exports: [SYSTEM_DATABASE, TransactionHost, KafkaProducer, DistributedLockService],
})
class InfrastructureStubModule {}

/** A consumer in the importing module: the writers and repositories are exported. */
@Injectable()
class Consumer {
  constructor(
    @Inject(FxOutbox) readonly fxWriter: FxOutbox,
    @Inject(FyOutbox) readonly fyWriter: FyOutbox,
    @Inject(FxOutboxSystemRepository) readonly fxRepository: FxOutboxSystemRepository,
    @Inject(FyOutboxSystemRepository) readonly fyRepository: FyOutboxSystemRepository,
  ) {}
}

const featureOf = (writer: OutboxWriter): OutboxFeature =>
  (writer as unknown as { feature: OutboxFeature }).feature;

describe('OutboxModule.forFeature', () => {
  let app: INestApplicationContext | undefined;

  const boot = async (): Promise<INestApplicationContext> => {
    @Module({
      imports: [
        { module: InfrastructureStubModule, global: true },
        OutboxModule.forFeature({
          feature: FX_OUTBOX,
          writer: FxOutbox,
          systemRepository: FxOutboxSystemRepository,
        }),
        OutboxModule.forFeature({
          feature: FY_OUTBOX,
          writer: FyOutbox,
          systemRepository: FyOutboxSystemRepository,
        }),
      ],
      providers: [Consumer],
    })
    class AppModule {}

    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    return app;
  };

  beforeEach(() => {
    lock.resources.length = 0;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  it('two calls give two writers, two repositories and two relays, each bound to its feature', async () => {
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
    const context = await boot();
    const consumer = context.get(Consumer);

    expect(consumer.fxWriter).toBeInstanceOf(FxOutbox);
    expect(consumer.fyWriter).toBeInstanceOf(FyOutbox);
    expect(featureOf(consumer.fxWriter)).toBe(FX_OUTBOX);
    expect(featureOf(consumer.fyWriter)).toBe(FY_OUTBOX);
    expect(consumer.fxRepository).toBeInstanceOf(FxOutboxSystemRepository);
    expect(consumer.fyRepository).toBeInstanceOf(FyOutboxSystemRepository);

    const fxRelay = context.get(outboxRelayToken('fx'), { strict: false });
    const fyRelay = context.get(outboxRelayToken('fy'), { strict: false });
    expect(fxRelay).toBeInstanceOf(OutboxRelay);
    expect(fyRelay).toBeInstanceOf(OutboxRelay);
    expect(fxRelay).not.toBe(fyRelay);
    expect(outboxRelayToken('fx')).not.toBe(outboxRelayToken('fy'));
    expect(lock.resources).toEqual([]);
  });

  it('starts each relay on bootstrap when enabled and a system pool is configured', async () => {
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'true');
    vi.stubEnv('DATABASE_SYSTEM_URL', 'postgres://app_system:s@127.0.0.1:1/app');
    await boot();
    await vi.waitFor(() =>
      expect([...lock.resources].sort()).toEqual(
        expect.arrayContaining(['outbox-relay:fx', 'outbox-relay:fy']),
      ),
    );
  });

  it('starts no relay without a system pool', async () => {
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'true');
    vi.stubEnv('DATABASE_SYSTEM_URL', '');
    const context = await boot();
    // The start decision is synchronous in `onApplicationBootstrap`, which `boot()` awaited:
    // neither relay has a running loop, so there is nothing left that could ask for the lock.
    for (const feature of ['fx', 'fy']) {
      const relay = context.get(outboxRelayToken(feature), { strict: false });
      expect(Reflect.get(relay, 'running')).toBeUndefined();
    }
    expect(lock.resources).toEqual([]);
  });
});
