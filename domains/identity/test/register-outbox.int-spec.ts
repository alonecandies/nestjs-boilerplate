import { MEMBERSHIP_CREATED_EVENT, USER_REGISTERED_EVENT } from '@domain/identity-contracts';
import { Global, Module } from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { AuthModule, RbacModule } from '@platform/auth';
import type { OutboxConfig } from '@platform/config';
import { parseEventEnvelope } from '@platform/contracts';
import { MailService } from '@platform/mailer';
import { OutboxRelay } from '@platform/outbox';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RegisterUserCommand } from '../src/application/commands/register-user/register-user.command.js';
import { SessionsRepository } from '../src/application/persistence/sessions.repository.js';
import { IDENTITY_RBAC } from '../src/identity.permissions.js';
import { IdentityCoreModule } from '../src/identity-core.module.js';
import { IdentityOutboxSystemRepository } from '../src/infrastructure/persistence/drizzle-outbox.system-repository.js';
import { IDENTITY_OUTBOX } from '../src/infrastructure/persistence/identity-outbox.js';
import { FakeRedisModule } from './auth-test.module.js';
import { type IdentityDatabase, startIdentityDatabase } from './identity-database.js';

/*
 * The registration event on identity's outbox (outbox plan Task 5): the real IdentityCoreModule on
 * the real DatabaseModule over Citus 14.2 (local execution off), migrated as app_owner, running as
 * app_runtime, the relay's repository on app_system. Only Redis, Kafka and mail are fakes. The
 * module's own relay is off (OUTBOX_RELAY_ENABLED=false); the spec drives one relay tick itself.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project identity:int register-outbox
 */

const PASSWORD = 'correct horse battery';
/** Whatever the request path publishes (it must stay empty). */
const kafka = new FakeKafkaProducer({ source: 'identity-int' });

@Global()
@Module({
  providers: [
    { provide: KafkaProducer, useValue: kafka },
    { provide: MailService, useValue: { enqueue: vi.fn(async () => undefined) } },
  ],
  exports: [KafkaProducer, MailService],
})
class FakeEdgesModule {}

const RELAY: OutboxConfig = {
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 100,
  lockTtlMs: 1_000,
  maxBackoffMs: 1_000,
  retentionHours: 168,
};

interface OutboxRow {
  tenant_id: string;
  id: string;
  topic: string;
  key: string | null;
  envelope: unknown;
  published_at: Date | null;
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'registration enqueues identity.user-registered.v1 in its unit of work (Citus)',
  () => {
    let database: IdentityDatabase | undefined;
    let admin: Sql;
    let bus: CommandBus;

    beforeAll(async () => {
      vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
      database = await startIdentityDatabase([], {
        testPermissions: false,
        imports: [
          FakeRedisModule,
          AuthModule.forRootAsync(),
          RbacModule.forFeature(IDENTITY_RBAC),
          CqrsModule.forRoot(),
          FakeEdgesModule,
          IdentityCoreModule,
        ],
      });
      admin = database.adminSql;
      bus = database.app.get(CommandBus);
      await database.app.init();
    }, 360_000);

    afterAll(async () => {
      await database?.close();
    });

    const outboxRows = (where: { tenant?: string } = {}) =>
      where.tenant === undefined
        ? admin<OutboxRow[]>`select * from identity.outbox order by created_at, id`
        : admin<OutboxRow[]>`select * from identity.outbox where tenant_id = ${where.tenant}
            order by created_at, id`;

    let tenantId: string;
    let userId: string;

    it('a registration leaves exactly one unpublished identity.user-registered.v1 row under the new tenant', async () => {
      const tokens = await bus.execute<
        RegisterUserCommand,
        { tenantId: string; user: { id: string } }
      >(new RegisterUserCommand('Grace@Example.com', PASSWORD, 'Grace'));
      tenantId = tokens.tenantId;
      userId = tokens.user.id;

      const rows = await outboxRows({ tenant: tenantId });
      const registered = rows.filter((row) => row.topic === USER_REGISTERED_EVENT.topic);
      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({ tenant_id: tenantId, key: userId, published_at: null });
      const envelope = parseEventEnvelope(USER_REGISTERED_EVENT, registered[0]?.envelope);
      expect(envelope).toMatchObject({
        id: registered[0]?.id,
        tenantId,
        actorId: userId,
        payload: { userId, email: 'grace@example.com', displayName: 'Grace' },
      });
      // Its personal-workspace membership rides the same unit of work (the B4 membership event).
      expect(rows.map((row) => row.topic).toSorted()).toEqual(
        [MEMBERSHIP_CREATED_EVENT.topic, USER_REGISTERED_EVENT.topic].toSorted(),
      );
      expect(rows.every((row) => row.published_at === null)).toBe(true);
      // Nothing went to Kafka from the request path.
      expect(kafka.records).toEqual([]);
    });

    it('a failure in the last repository call of the unit of work leaves neither the user nor a row', async () => {
      const before = (await outboxRows()).length;
      const sessions = database?.app.get(SessionsRepository) as SessionsRepository;
      const failure = vi.spyOn(sessions, 'create').mockRejectedValueOnce(new Error('boom'));
      await expect(
        bus.execute(new RegisterUserCommand('hopper@example.com', PASSWORD, 'Hopper')),
      ).rejects.toThrow('boom');
      expect(failure).toHaveBeenCalledTimes(1);
      failure.mockRestore();

      const [user] = await admin<{ n: number }[]>`
        select count(*)::int as n from identity.users where email = 'hopper@example.com'`;
      expect(user?.n).toBe(0);
      expect(await outboxRows()).toHaveLength(before);
      const [rolledBack] = await admin<{ n: number }[]>`
        select count(*)::int as n from identity.outbox
        where envelope -> 'payload' ->> 'email' = 'hopper@example.com'`;
      expect(rolledBack?.n).toBe(0);
      expect(kafka.records).toEqual([]);
    });

    it('one tick of a real OutboxRelay publishes an envelope that parses with USER_REGISTERED_EVENT and marks the row', async () => {
      const published = new FakeKafkaProducer({ source: 'identity-int' });
      const relay = new OutboxRelay(
        IDENTITY_OUTBOX,
        database?.app.get(IdentityOutboxSystemRepository) as IdentityOutboxSystemRepository,
        published,
        { using: () => Promise.reject(new Error('a tick takes no lock')) },
        RELAY,
        { systemPool: true },
      );

      const result = await relay.tick(new AbortController().signal);
      expect(result).toEqual({ polled: 2, published: 2, failed: false });

      const [registered] = await outboxRows({ tenant: tenantId }).then((rows) =>
        rows.filter((row) => row.topic === USER_REGISTERED_EVENT.topic),
      );
      const [record] = published.published(USER_REGISTERED_EVENT);
      expect(record?.key).toBe(userId);
      const envelope = parseEventEnvelope(USER_REGISTERED_EVENT, record?.value);
      expect(envelope).toMatchObject({
        id: registered?.id,
        tenantId,
        actorId: userId,
        payload: { userId, email: 'grace@example.com', displayName: 'Grace' },
      });
      expect(registered?.published_at).toBeInstanceOf(Date);
      expect((await outboxRows()).every((row) => row.published_at !== null)).toBe(true);
      // The membership event went out on the same tick, in the new tenant.
      expect(published.envelopes(MEMBERSHIP_CREATED_EVENT)).toEqual([
        expect.objectContaining({ tenantId, payload: expect.objectContaining({ userId }) }),
      ]);
    });
  },
);
