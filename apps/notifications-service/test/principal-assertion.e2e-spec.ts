import {
  NOTIFICATIONS_GRPC_PACKAGE,
  type NotificationPage,
  type NotificationsServiceClient,
} from '@domain/notifications-contracts';
import { type Metadata, type ServiceError, status } from '@grpc/grpc-js';
import { getQueueToken } from '@nestjs/bullmq';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CASSANDRA_CLIENT } from '@platform/cassandra';
import { generateId } from '@platform/common';
import { grpcConfig } from '@platform/config';
import { MAIL_QUEUE, MailProcessor } from '@platform/mailer';
import { REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import {
  createGrpcClientOptions,
  createOutgoingMetadata,
  GRPC_METADATA_KEYS,
  KafkaProducer,
} from '@platform/transport';
import {
  createTestPrincipalSigner,
  FakeKafkaProducer,
  withBoundGrpcPort,
} from '@platform/transport/testing';
import cassandra from 'cassandra-driver';
import { lastValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakeCassandra } from './support/fake-cassandra.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * notifications-service under GRPC_PRINCIPAL_ASSERTION=enforce (B2-12): the REAL AppModule,
 * configured from the environment like a deployed service (public key only, no signing key), with
 * fakes at the network edges as in app.e2e-spec.ts. An inbox is read by its owner's (tenant, user)
 * principal, so a mesh peer without the edge's private key cannot read anyone's inbox by naming the
 * pair in plain headers. The other e2e specs keep the default `off`.
 */

const USER_ID = '01920000-0000-7000-8000-000000000001';
const TENANT_ID = '01920000-0000-7000-8000-0000000000a1';
// A live uuidv7: the inbox keeps 90 days.
const WELCOME_ID = generateId();
const WELCOME_AT = new Date('2026-09-29T08:00:00.000Z');
const uuid = (id: string): cassandra.types.Uuid => cassandra.types.Uuid.fromString(id);

/** One inbox row as the driver returns it. */
const INBOX_ROWS = [
  {
    tenant_id: uuid(TENANT_ID),
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
  if (cql.includes('FROM notifications_by_tenant_user WHERE tenant_id = ? AND user_id = ?')) {
    return params[0] === TENANT_ID && params[1] === USER_ID ? { rows: INBOX_ROWS } : {};
  }
  return {};
});

/** The mail queue at the network edge: MailService only attaches its error logger here. */
const mailQueue = {
  add: async () => ({ id: 'job-1' }),
  toKey: (type: string) => `bull:mail:${type}`,
  getBackend: () => ({ client: Promise.resolve({ get: async () => null, set: async () => 'OK' }) }),
  on: () => mailQueue,
  close: async () => undefined,
};

describe('notifications-service with GRPC_PRINCIPAL_ASSERTION=enforce', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let notifications: NotificationsServiceClient;
  const signer = createTestPrincipalSigner('edge-e2e');
  /** The inbox owner, as the gateway adapter derives it from its CLS principal. */
  const owner = { userId: USER_ID, tenantId: TENANT_ID, roles: ['member'] };
  const listInbox = (metadata: Metadata): Observable<NotificationPage> =>
    notifications.listNotifications({ tenantId: TENANT_ID, userId: USER_ID, limit: 5 }, metadata);
  const failureOf = (source: Observable<unknown>): Promise<ServiceError> =>
    lastValueFrom(source).then(
      () => {
        throw new Error('expected the call to fail');
      },
      (error: unknown) => error as ServiceError,
    );
  const errorCode = (error: ServiceError): unknown =>
    error.metadata.get(GRPC_METADATA_KEYS.ERROR_CODE)[0];
  /** The inbox reads this run sent to Cassandra. */
  const inboxReads = () =>
    store.executed.filter(({ cql }) => cql.includes('FROM notifications_by_tenant_user'));

  beforeAll(async () => {
    const env: Record<string, string> = {
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'notifications-service',
      // Port 0: the server binds an OS-chosen port, read back after it started.
      GRPC_URL: '127.0.0.1:0',
      GRPC_DEADLINE_MS: '3000',
      // Nothing may reach real infrastructure: unreachable ports wherever a client could connect.
      CASSANDRA_CONTACT_POINTS: '127.0.0.1',
      CASSANDRA_PORT: '1',
      REDIS_URL: 'redis://127.0.0.1:1',
      KAFKA_BROKERS: '127.0.0.1:1',
      SMTP_PORT: '1',
      // A deployed service: it verifies with the edge's public key and holds no signing key.
      GRPC_PRINCIPAL_ASSERTION: 'enforce',
      GRPC_PRINCIPAL_PUBLIC_KEYS: signer.publicKeysEnv,
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CASSANDRA_CLIENT)
      .useValue(store.client)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new InMemoryRedis().asRedis())
      .overrideProvider(KafkaProducer)
      .useValue(new FakeKafkaProducer({ source: 'notifications-service' }))
      .overrideProvider(getQueueToken(MAIL_QUEUE))
      .useValue(mailQueue)
      // A plain value is not a @Processor: BullMQ's explorer starts no Worker (it would dial Redis).
      .overrideProvider(MailProcessor)
      .useValue({});
    const started = await withBoundGrpcPort(() =>
      startServiceTestApp(builder, { grpc: [NOTIFICATIONS_GRPC_PACKAGE] }),
    );
    app = started.value;
    const grpcUrl = `127.0.0.1:${started.port}`;

    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), {
        spec: NOTIFICATIONS_GRPC_PACKAGE,
        url: grpcUrl,
      }).options,
    );
    notifications = client.getService<NotificationsServiceClient>('NotificationsService');
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.close();
    vi.unstubAllEnvs();
  }, 30_000);

  it('refuses plain headers naming the (tenant, user) of an inbox; no CQL runs', async () => {
    const before = store.executed.length;
    const error = await failureOf(listInbox(createOutgoingMetadata(owner)));
    expect(error.code).toBe(status.UNAUTHENTICATED);
    expect(errorCode(error)).toBe('INVALID_PRINCIPAL');
    expect(store.executed).toHaveLength(before); // refused before any handler ran
  });

  it('accepts the same call with a signed assertion: the owner reads that inbox', async () => {
    const page = await lastValueFrom(listInbox(signer.metadata(owner)));
    expect(page.items).toEqual([
      expect.objectContaining({
        id: WELCOME_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        type: 'welcome',
      }),
    ]);
    expect(inboxReads().at(-1)?.params).toEqual([TENANT_ID, USER_ID]);
  });
});
