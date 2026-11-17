import {
  MEMBERSHIP_CREATED_EVENT,
  MEMBERSHIP_REMOVED_EVENT,
  USER_REGISTERED_EVENT,
} from '@domain/identity-contracts';
import {
  NOTIFICATION_CREATED_EVENT,
  NOTIFICATIONS_GRPC_PACKAGE,
  type NotificationPage,
  type NotificationsServiceClient,
} from '@domain/notifications-contracts';
import { type ServiceError, status } from '@grpc/grpc-js';
import { getQueueToken } from '@nestjs/bullmq';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CASSANDRA_CLIENT } from '@platform/cassandra';
import { DomainValidationException, EntityNotFoundException, generateId } from '@platform/common';
import { type GrpcConfig, grpcConfig } from '@platform/config';
import { createEventEnvelope } from '@platform/contracts';
import { MAIL_QUEUE, MailProcessor } from '@platform/mailer';
import { MetricsListener } from '@platform/observability';
import { REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import {
  createGrpcClientOptions,
  GrpcCircuitBreakers,
  grpcCall,
  KafkaProducer,
} from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import cassandra from 'cassandra-driver';
import { lastValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakeCassandra } from './support/fake-cassandra.js';
import { freePort } from './support/free-port.js';
import { InMemoryKafkaServer } from './support/in-memory-kafka.server.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * notifications-service end to end, no Docker: the REAL AppModule (CQRS handlers + saga,
 * Cassandra repositories, mailer, observability, common enhancers) with fakes only at the network
 * edges — a Cassandra client answering CQL, an in-memory Redis, a recording BullMQ queue and Kafka
 * producer. gRPC is real (loopback server + gateway-style ClientGrpcProxy); the Kafka consumer runs
 * on an in-process transport registered like `connectKafkaConsumer` (inheritAppConfig).
 */

const USER_ID = '01920000-0000-7000-8000-000000000001';
// A live uuidv7: markRead skips ids whose embedded time is past the 90-day inbox TTL.
const WELCOME_ID = generateId();
const RECEIPT_ID = '01920000-0000-7000-8000-00000000000b';
const WELCOME_AT = new Date('2026-09-29T08:00:00.000Z');
const RECEIPT_AT = new Date('2026-09-29T08:30:00.250Z');
const uuid = (id: string): cassandra.types.Uuid => cassandra.types.Uuid.fromString(id);

/** Inbox rows as the driver returns them (uuid cells are `types.Uuid`, an empty map is null). */
const INBOX_ROWS = [
  {
    user_id: uuid(USER_ID),
    notification_id: uuid(RECEIPT_ID),
    type: 'payment_receipt',
    title: 'Payment received',
    body: 'Thanks! We received 25.00 USD.',
    data: { paymentId: '01920000-0000-7000-8000-0000000000ff', amount: '25.00' },
    read: true,
    created_at: RECEIPT_AT,
  },
  {
    user_id: uuid(USER_ID),
    notification_id: uuid(WELCOME_ID),
    type: 'welcome',
    title: 'Welcome aboard!',
    body: 'Hi Ada, your account is ready. Enjoy!',
    data: null,
    read: null,
    created_at: WELCOME_AT,
  },
];

const store = createFakeCassandra((cql, params) => {
  if (cql.startsWith('SELECT release_version FROM system.local')) {
    return { rows: [{ release_version: '5.0.4' }] };
  }
  if (cql.includes('FROM notifications_by_user WHERE user_id = ?')) {
    return params[0] === USER_ID ? { rows: INBOX_ROWS, pageState: 'c0ffee' } : {};
  }
  if (cql.startsWith('UPDATE notifications_by_user USING TTL ? SET read = true')) {
    return { applied: params[2] === WELCOME_ID }; // LWT: IF EXISTS (params: ttl, user, id)
  }
  return {}; // inserts / upserts
});

const mailQueue = {
  add: vi.fn(async () => ({ id: 'job-1' })),
  // MailService attaches its connection-error logger at init.
  on: vi.fn(),
  close: vi.fn(async () => undefined),
};
const kafkaProducer = new FakeKafkaProducer({ source: 'notifications-service' });
const kafka = new InMemoryKafkaServer();

describe('notifications-service (real AppModule, fakes at the network edges)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let notifications: NotificationsServiceClient;
  const breakers = new GrpcCircuitBreakers();

  /** What the gateway adapter does: deadline + breaker + ServiceError → DomainException. */
  const call = <T>(source: Observable<T>, operation: string): Promise<T> =>
    grpcCall(source, { timeoutMs: 3_000, operation, breaker: breakers.get('notifications') });

  beforeAll(async () => {
    const grpcUrl = `127.0.0.1:${await freePort()}`;
    const env: Record<string, string> = {
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'notifications-service',
      GRPC_URL: grpcUrl,
      GRPC_DEADLINE_MS: '3000',
      // Nothing may reach real infrastructure: unreachable ports wherever a client could connect.
      CASSANDRA_CONTACT_POINTS: '127.0.0.1',
      CASSANDRA_PORT: '1',
      REDIS_URL: 'redis://127.0.0.1:1',
      KAFKA_BROKERS: '127.0.0.1:1',
      SMTP_PORT: '1',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CASSANDRA_CLIENT)
      .useValue(store.client)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new InMemoryRedis().asRedis())
      .overrideProvider(KafkaProducer)
      .useValue(kafkaProducer)
      .overrideProvider(getQueueToken(MAIL_QUEUE))
      .useValue(mailQueue)
      // A plain value is not a @Processor: BullMQ's explorer starts no Worker (it would dial Redis).
      .overrideProvider(MailProcessor)
      .useValue({});
    app = await startServiceTestApp(builder, { grpc: [NOTIFICATIONS_GRPC_PACKAGE], kafka });

    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), {
        spec: NOTIFICATIONS_GRPC_PACKAGE,
        url: grpcUrl,
      }).options,
    );
    notifications = client.getService<NotificationsServiceClient>('NotificationsService');
  }, 60_000);

  afterAll(async () => {
    breakers.onApplicationShutdown();
    client?.close();
    await app?.close();
    vi.unstubAllEnvs();
    // The Cassandra session is released by CassandraModule's shutdown hook.
    expect(store.shutdown).toHaveBeenCalled();
  }, 30_000);

  describe('HTTP (ops only)', () => {
    it('GET /health/live → 200 without touching any dependency', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('GET /metrics is not served on the HTTP port (METRICS_PORT has its own listener)', async () => {
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    });

    it('the metrics listener answers with Node default metrics and the HTTP latency histogram', async () => {
      await app.inject({ method: 'GET', url: '/health/live' });
      const scrape = await app.get(MetricsListener, { strict: false }).scrape();
      expect(scrape.status).toBe(200);
      expect(scrape.contentType).toMatch(/^text\/plain/);
      expect(scrape.body).toContain('process_cpu_user_seconds_total');
      expect(scrape.body).toContain('# TYPE http_request_duration_seconds histogram');
    });

    it('GET /health/ready → checks exactly cassandra, redis and kafka (no broker → 503)', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      const body = response.json<{ info: object; error: object }>();
      expect(Object.keys({ ...body.info, ...body.error }).sort()).toEqual([
        'cassandra',
        'kafka',
        'redis',
      ]);
      expect(body.info).toMatchObject({ cassandra: { status: 'up' }, redis: { status: 'up' } });
      expect(body.error).toMatchObject({ kafka: { status: 'down' } });
      expect(response.statusCode).toBe(503);
    }, 15_000);
  });

  describe('gRPC notifications.v1', () => {
    it('the gRPC namespace resolves from the app container (connectGrpcServer never falls back)', () => {
      // On a NestFactory app a missed `app.get` is logged at ERROR by Nest's exception proxy
      // before transport falls back to parsing the env, so AppModule loads the namespace itself.
      expect(app.get<GrpcConfig, GrpcConfig>(grpcConfig.KEY, { strict: false }).url).toMatch(
        /^127\.0\.0\.1:\d+$/,
      );
    });

    it('ListNotifications reads one Cassandra page; Timestamp → Date, map + bool defaults', async () => {
      const page: NotificationPage = await call(
        notifications.listNotifications({ userId: USER_ID, limit: 2 }),
        'NotificationsService.ListNotifications',
      );

      expect(page.nextPageState).toBe('c0ffee');
      expect(page.items).toHaveLength(2);
      const [receipt, welcome] = page.items;
      expect(receipt).toMatchObject({
        id: RECEIPT_ID,
        userId: USER_ID,
        type: 'payment_receipt',
        read: true,
        data: { amount: '25.00' },
        createdAt: RECEIPT_AT,
      });
      expect(welcome).toMatchObject({ id: WELCOME_ID, type: 'welcome', read: false, data: {} });
      expect(welcome?.createdAt).toBeInstanceOf(Date);
      expect(welcome?.createdAt?.toISOString()).toBe(WELCOME_AT.toISOString());

      expect(store.executed.at(-1)).toMatchObject({
        params: [USER_ID],
        options: { prepare: true, fetchSize: 2 },
      });
    });

    it('ListNotifications with a malformed page state → INVALID_ARGUMENT before any CQL', async () => {
      const before = store.executed.length;
      const request = { userId: USER_ID, limit: 5, pageState: 'not hex!' };
      const raw = await lastValueFrom(notifications.listNotifications(request)).catch(
        (e: unknown) => e,
      );
      expect(raw).toMatchObject({ code: status.INVALID_ARGUMENT });

      const error = await call(
        notifications.listNotifications(request),
        'NotificationsService.ListNotifications',
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainValidationException);
      expect(store.executed).toHaveLength(before);
    });

    it('MarkNotificationRead: LWT applied → Empty; unknown id → NOT_FOUND with its domain code', async () => {
      await expect(
        call(
          notifications.markNotificationRead({ userId: USER_ID, notificationId: WELCOME_ID }),
          'NotificationsService.MarkNotificationRead',
        ),
      ).resolves.toEqual({});

      const request = { userId: USER_ID, notificationId: generateId() };
      const raw = await lastValueFrom(notifications.markNotificationRead(request)).catch(
        (e: unknown) => e,
      );
      expect(raw).toMatchObject({ code: status.NOT_FOUND });
      expect((raw as ServiceError).metadata.get('x-error-code')).toEqual([
        'NOTIFICATION_NOT_FOUND',
      ]);

      const error = await call(
        notifications.markNotificationRead(request),
        'NotificationsService.MarkNotificationRead',
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EntityNotFoundException);
      expect(error).toMatchObject({ httpStatus: 404, code: 'NOTIFICATION_NOT_FOUND' });
    });

    it('caller errors never open the circuit breaker', () => {
      expect(breakers.states()['notifications']).toBe('closed');
    });
  });

  describe('Kafka consumers (group notifications-service)', () => {
    beforeEach(() => {
      kafkaProducer.clear();
      kafka.producer.send.mockClear();
    });

    it('identity.user-registered.v1 → inbox row, welcome mail queued, event published', async () => {
      const userId = generateId();
      const envelope = createEventEnvelope(
        USER_REGISTERED_EVENT,
        {
          userId,
          email: 'grace@example.com',
          displayName: 'Grace',
          registeredAt: '2026-09-29T09:00:00.000Z',
        },
        { id: generateId(), source: 'identity-service', tenantId: generateId() },
      );

      await kafka.deliver(USER_REGISTERED_EVENT.topic, envelope, userId);

      const writes = store.executed.filter(({ params }) => params[0] === userId).map((q) => q.cql);
      // Recipients follow memberships (identity.membership-created.v1), not registrations.
      expect(writes).toEqual([expect.stringContaining('INSERT INTO notifications_by_user')]);
      expect(mailQueue.add).toHaveBeenCalledWith(
        'welcome',
        expect.objectContaining({ to: 'grace@example.com', template: 'welcome' }),
        expect.objectContaining({ jobId: `welcome-${userId}` }),
      );
      // The saga publishes asynchronously on the event stream.
      await vi.waitFor(() =>
        expect(kafkaProducer.envelopes(NOTIFICATION_CREATED_EVENT)).toHaveLength(1),
      );
      expect(kafkaProducer.envelopes(NOTIFICATION_CREATED_EVENT)[0]).toMatchObject({
        source: 'notifications-service',
        payload: { userId, type: 'welcome' },
      });
      expect(kafka.deadLetters()).toEqual([]);
    });

    /** The recipient statements this test run executed for `userId`. */
    const recipientWrites = (userId: string) =>
      store.executed.filter(
        ({ cql, params }) =>
          cql.includes('notification_recipients_by_tenant') && params.includes(userId),
      );

    it('identity.membership-created.v1 → recipient INSERT bound to the envelope tenant', async () => {
      const [tenantId, userId] = [generateId(), generateId()];
      const envelope = createEventEnvelope(
        MEMBERSHIP_CREATED_EVENT,
        {
          userId,
          email: 'grace@example.com',
          displayName: 'Grace',
          createdAt: '2026-09-29T09:00:00.000Z',
        },
        { id: generateId(), source: 'identity-service', tenantId, actorId: userId },
      );

      await kafka.deliver(MEMBERSHIP_CREATED_EVENT.topic, envelope, userId);

      const [insert, ...rest] = recipientWrites(userId);
      expect(rest).toEqual([]);
      expect(insert?.cql).toMatch(/^INSERT INTO notification_recipients_by_tenant /);
      expect(insert?.params.slice(0, 4)).toEqual([tenantId, userId, 'grace@example.com', 'Grace']);
      expect(kafka.deadLetters()).toEqual([]);
    });

    it('identity.membership-removed.v1 → recipient DELETE bound to the envelope tenant', async () => {
      const [tenantId, userId] = [generateId(), generateId()];
      const envelope = createEventEnvelope(
        MEMBERSHIP_REMOVED_EVENT,
        { userId, removedAt: '2026-09-29T10:00:00.000Z' },
        { id: generateId(), source: 'identity-service', tenantId, actorId: userId },
      );

      await kafka.deliver(MEMBERSHIP_REMOVED_EVENT.topic, envelope, userId);

      const [remove, ...rest] = recipientWrites(userId);
      expect(rest).toEqual([]);
      expect(remove?.cql).toMatch(/^DELETE FROM notification_recipients_by_tenant /);
      expect(remove?.params.slice(1)).toEqual([tenantId, userId]);
      expect(kafka.deadLetters()).toEqual([]);
    });

    /** A tenant-scoped envelope as a pre-B2-24 producer sent it: no `tenantId`. */
    const legacy = <T extends { tenantId?: string | undefined }>(envelope: T) => {
      const { tenantId: _tenantId, ...rest } = envelope;
      return rest;
    };
    const meta = () => ({ id: generateId(), source: 'identity-service', tenantId: generateId() });

    it.each([
      [
        MEMBERSHIP_CREATED_EVENT.topic,
        (userId: string) =>
          createEventEnvelope(
            MEMBERSHIP_CREATED_EVENT,
            {
              userId,
              email: 'x@example.com',
              displayName: 'X',
              createdAt: '2026-09-29T09:00:00.000Z',
            },
            meta(),
          ),
      ],
      [
        MEMBERSHIP_REMOVED_EVENT.topic,
        (userId: string) =>
          createEventEnvelope(
            MEMBERSHIP_REMOVED_EVENT,
            { userId, removedAt: '2026-09-29T10:00:00.000Z' },
            meta(),
          ),
      ],
    ])(
      '%s without tenantId lands on the .dlq topic and touches no recipient row',
      async (topic, build) => {
        const userId = generateId();

        await kafka.deliver(topic, legacy(build(userId)), userId);

        expect(recipientWrites(userId)).toEqual([]);
        expect(kafka.deadLetters()).toEqual([expect.objectContaining({ topic: `${topic}.dlq` })]);
      },
    );

    it('a malformed envelope is dead-lettered (offset commits; the consumer never throws)', async () => {
      await expect(
        kafka.deliver(USER_REGISTERED_EVENT.topic, { id: 'nope', payload: {} }),
      ).resolves.toBeUndefined();

      expect(kafka.deadLetters()).toEqual([
        expect.objectContaining({ topic: `${USER_REGISTERED_EVENT.topic}.dlq` }),
      ]);
      expect(kafkaProducer.records).toEqual([]);
    });
  });
});
