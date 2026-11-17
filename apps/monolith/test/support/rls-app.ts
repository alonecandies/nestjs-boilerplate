import { StripeService } from '@domain/billing';
import { getQueueToken } from '@nestjs/bullmq';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { buildFastifyOptions, configureHttpApp, setupApiDocs } from '@platform/bootstrap';
import { CASSANDRA_CLIENT } from '@platform/cassandra';
import { appConfig } from '@platform/config';
import { GRAPHQL_PUB_SUB } from '@platform/graphql';
import { MAIL_QUEUE, MailProcessor } from '@platform/mailer';
import { REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { StorageService } from '@platform/storage';
import { InMemoryStorageService } from '@platform/storage/testing';
import { createFastifyTestApp } from '@platform/testing';
import type { RlsTestPostgres } from '@platform/testing/postgres';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { PubSub } from 'graphql-subscriptions';
import postgres from 'postgres';
import { vi } from 'vitest';
import { MONOLITH_API_DOCS } from '../../src/app.constants.js';
import { AppModule } from '../../src/app.module.js';
import { createFakeCassandra, createFakeQueue, createL1OnlyCache } from './fake-infrastructure.js';

export type RlsApp = Awaited<ReturnType<typeof startRlsApp>>;

export interface RlsAppOptions {
  /** `DATABASE_PREPARE`: server-side prepared statements on the runtime and system pools. */
  prepare: boolean;
  /** `DATABASE_POOL_MAX` of the runtime pool; four connections is the suite's reuse pressure. */
  poolMax?: number;
}

/** A Stripe Checkout Session as the billing handler reads it (`id`, `url`, amount, currency). */
interface FakeCheckoutSession {
  id: string;
  url: string;
  amount_total: number;
  currency: string;
  status: 'open';
}

/**
 * The only Stripe the suite has: a recording stand-in for `StripeService`. Every other part of
 * billing (handlers, repositories, the unit of work, the policies) is the real code.
 */
class FakeStripe {
  readonly created: { sessionId: string; paymentId: string; tenantId: string }[] = [];
  private readonly sessions = new Map<string, FakeCheckoutSession>();

  async createCheckoutSession(
    input: {
      quantity: number;
      clientReferenceId: string;
      metadata: Record<string, string>;
    },
    _idempotencyKey?: string,
  ): Promise<FakeCheckoutSession> {
    const session: FakeCheckoutSession = {
      id: `cs_test_rls_${this.sessions.size + 1}`,
      url: `https://checkout.example.test/pay/${this.sessions.size + 1}`,
      amount_total: 2_500 * input.quantity,
      currency: 'usd',
      status: 'open',
    };
    this.sessions.set(session.id, session);
    this.created.push({
      sessionId: session.id,
      paymentId: input.clientReferenceId,
      tenantId: input.metadata['tenantId'] ?? '',
    });
    return session;
  }

  async retrieveCheckoutSession(id: string): Promise<FakeCheckoutSession> {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error(`unknown checkout session ${id}`);
    return session;
  }
}

/**
 * Boots the REAL `AppModule` (identity, billing, notifications and files together, the production
 * HTTP wiring) on a real Citus container with the three roles of `startRlsTestPostgres()`:
 *
 * - `DatabaseModule` migrates as `app_owner` (`DATABASE_MIGRATION_URL`, both migration sets), runs
 *   every request as `app_runtime` (`DATABASE_URL`) and opens the system pool as `app_system`
 *   (`DATABASE_SYSTEM_URL`). The boot guard is `enforce`: the app does not start unless roles,
 *   FORCE RLS and grants are as required.
 * - No repository, runner or `RlsElevation` is replaced (the e2e harness replaces all of them with
 *   in-memory persistence, which has no policies and no unit of work).
 * - Fakes sit at the network edges only: Redis, Cassandra, the mail queue, Kafka, the GraphQL
 *   pub/sub, storage, and Stripe (`FakeStripe`).
 *
 * `admin` is a superuser client (seeding and "what is really there"); `runtime` is a client that
 * logs in as `app_runtime` for queries that bypass the application.
 *
 * Call it from a spec whose first statement applied `MONOLITH_E2E_ENV` (`vi.hoisted`), exactly like
 * the e2e suites: `ObservabilityModule.forRoot()` reads it while `AppModule` is imported.
 */
export async function startRlsApp(pg: RlsTestPostgres, options: RlsAppOptions) {
  vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
  vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
  vi.stubEnv('DATABASE_MIGRATION_URL', pg.migrationUrl);
  vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'true');
  vi.stubEnv('DATABASE_BOOT_GUARD', 'enforce');
  vi.stubEnv('DATABASE_POOL_MAX', String(options.poolMax ?? 4));
  vi.stubEnv('DATABASE_PREPARE', String(options.prepare));
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_rls_journeys');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_rls_journeys');

  const config = appConfig.parse();
  const redis = new InMemoryRedis();
  const kafka = new FakeKafkaProducer({ source: config.serviceName });
  const cassandra = createFakeCassandra();
  const mailQueue = createFakeQueue();
  const storage = new InMemoryStorageService();
  const stripe = new FakeStripe();
  const admin = postgres(pg.url, { max: 2, onnotice: () => undefined });
  const runtime = postgres(pg.runtimeUrl, { max: 4, onnotice: () => undefined });

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis.asRedis())
    .overrideProvider(CASSANDRA_CLIENT)
    .useValue(cassandra.client)
    .overrideProvider(getQueueToken(MAIL_QUEUE))
    .useValue(mailQueue)
    // A plain value is not a @Processor for BullMQ's explorer: no Worker connecting to Redis.
    .overrideProvider(MailProcessor)
    .useValue({})
    .overrideProvider(CACHE_MANAGER)
    .useValue(createL1OnlyCache())
    .overrideProvider(KafkaProducer)
    .useValue(kafka)
    .overrideProvider(GRAPHQL_PUB_SUB)
    .useValue(new PubSub())
    .overrideProvider(StorageService)
    .useValue(storage)
    .overrideProvider(StripeService)
    .useValue(stripe);

  let app: NestFastifyApplication;
  try {
    app = await createFastifyTestApp(
      builder,
      async (created) => {
        await configureHttpApp(created, { config, shutdownHooks: false, processHandlers: false });
        setupApiDocs(created, MONOLITH_API_DOCS);
      },
      {
        adapter: new FastifyAdapter(buildFastifyOptions(config, { multipart: true })),
        appOptions: { bufferLogs: true, rawBody: true },
      },
    );
  } catch (error) {
    await Promise.all([admin.end({ timeout: 5 }), runtime.end({ timeout: 5 })]);
    throw error;
  }

  const close = async (): Promise<void> => {
    await app.close();
    await Promise.all([admin.end({ timeout: 5 }), runtime.end({ timeout: 5 })]);
  };
  return {
    app,
    admin,
    runtime,
    redis,
    kafka,
    mailQueue,
    storage,
    stripe,
    close,
  };
}
