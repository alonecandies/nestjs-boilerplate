import { buildClientOptions, type CassandraClient, CqlMigrator } from '@platform/cassandra';
import { generateId } from '@platform/common';
import { cassandraConfig } from '@platform/config';
import type { MailMessage, MailService } from '@platform/mailer';
import { createMock } from '@platform/testing';
import { startTestCassandra, type TestCassandra } from '@platform/testing/cassandra';
import cassandra from 'cassandra-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SendDailyDigestCommand } from '../src/application/commands/send-daily-digest/send-daily-digest.command.js';
import { SendDailyDigestHandler } from '../src/application/commands/send-daily-digest/send-daily-digest.handler.js';
import type { NotificationProps } from '../src/domain/notification.types.js';
import { CassandraNotificationRecipientsRepository } from '../src/infrastructure/persistence/cassandra-notification-recipients.repository.js';
import { CassandraNotificationsRepository } from '../src/infrastructure/persistence/cassandra-notifications.repository.js';
import { notificationsCassandraMigrations } from '../src/infrastructure/persistence/notifications-cassandra.migrations.js';
import { asClass } from './support/fixtures.js';

/*
 * The (tenant, user) inbox against a real Cassandra: all five migrations of the context, the
 * production repositories on a client built with the production driver options, and the digest
 * handler over both. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project notifications:int test/inbox-isolation
 */

/** A fresh, live notification (uuidv7 of now: markRead skips ids past the 90-day TTL). */
const notification = (tenantId: string, userId: string, title: string): NotificationProps => ({
  id: generateId(),
  tenantId,
  userId,
  type: 'system',
  title,
  body: `${title} body`,
  data: {},
  read: false,
  createdAt: new Date(),
});

const ids = (items: readonly NotificationProps[]): string[] => items.map((item) => item.id);

describe.skipIf(process.env['INTEGRATION'] !== '1')('(tenant, user) inbox (Cassandra)', () => {
  let node: TestCassandra | undefined;
  let client: CassandraClient | undefined;
  let inbox: CassandraNotificationsRepository;
  let recipients: CassandraNotificationRecipientsRepository;

  beforeAll(async () => {
    node = await startTestCassandra();
    const cfg = cassandraConfig.parse({
      CASSANDRA_CONTACT_POINTS: node.contactPoints.join(','),
      CASSANDRA_LOCAL_DC: node.localDataCenter,
      CASSANDRA_KEYSPACE: node.keyspace,
    });
    client = new cassandra.Client(
      buildClientOptions(cfg, { applicationName: 'notifications-int', keyspace: node.keyspace }),
    );
    await client.connect();
    await new CqlMigrator(client, {
      keyspace: node.keyspace,
      sources: [notificationsCassandraMigrations],
    }).run();
    inbox = new CassandraNotificationsRepository(client);
    recipients = new CassandraNotificationRecipientsRepository(client);
  });

  afterAll(async () => {
    await client?.shutdown();
    await node?.stop();
  });

  it('005 dropped the two user-keyed tables; the (tenant, user) tables exist', async () => {
    if (client === undefined || node === undefined) throw new Error('Cassandra did not start');
    const rs = await client.execute(
      'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
      [node.keyspace],
      { prepare: true },
    );
    const tables = rs.rows.map((row) => String(row.get('table_name')));
    expect(tables).not.toContain('notifications_by_user');
    expect(tables).not.toContain('notification_recipients');
    expect(tables).toEqual(
      expect.arrayContaining(['notifications_by_tenant_user', 'notification_recipients_by_tenant']),
    );
  });

  it('lists each (tenant, user) inbox alone; markRead only reaches its own pair', async () => {
    const [a, b, u, v] = [generateId(), generateId(), generateId(), generateId()];
    const n1 = notification(a, u, 'n1');
    const n2 = notification(b, u, 'n2');
    const n3 = notification(a, v, 'n3');
    for (const n of [n1, n2, n3]) await inbox.insert(n);

    expect(ids((await inbox.listByUser(a, u, 10)).items)).toEqual([n1.id]);
    expect(ids((await inbox.listByUser(b, u, 10)).items)).toEqual([n2.id]);
    expect(ids((await inbox.listByUser(a, v, 10)).items)).toEqual([n3.id]);

    // n1 is not in (B, U): the conditional update finds no row, and n1 stays unread.
    await expect(inbox.markRead(b, u, n1.id)).resolves.toBe(false);
    expect((await inbox.listByUser(a, u, 10)).items).toEqual([
      expect.objectContaining({ id: n1.id, read: false }),
    ]);

    await expect(inbox.markRead(a, u, n1.id)).resolves.toBe(true);
    expect((await inbox.listByUser(a, u, 10)).items).toEqual([
      expect.objectContaining({ id: n1.id, tenantId: a, userId: u, read: true }),
    ]);
    expect((await inbox.listByUser(b, u, 10)).items).toEqual([
      expect.objectContaining({ id: n2.id, read: false }),
    ]);
  });

  it('a paging state of (A, U) replayed on (B, U) never yields an (A, U) row', async () => {
    const [a, b, u] = [generateId(), generateId(), generateId()];
    const inA = [1, 2, 3].map((i) => notification(a, u, `a${i}`));
    const inB = [1, 2, 3].map((i) => notification(b, u, `b${i}`));
    for (const n of [...inA, ...inB]) await inbox.insert(n);

    const first = await inbox.listByUser(a, u, 2);
    expect(first.items).toHaveLength(2);
    expect(first.pageState).toEqual(expect.any(String));

    // Cassandra may reject the foreign state or page (B, U) from it; either is safe.
    const replayed = await inbox.listByUser(b, u, 2, first.pageState ?? undefined).then(
      (slice) => slice.items,
      () => [] as NotificationProps[],
    );
    for (const item of replayed) {
      expect(item).toMatchObject({ tenantId: b, userId: u });
      expect(ids(inA)).not.toContain(item.id);
    }
  });

  it('re-inserting a read notification keeps it read', async () => {
    const [a, u] = [generateId(), generateId()];
    const n = notification(a, u, 'redelivered');
    await inbox.insert(n);
    await expect(inbox.markRead(a, u, n.id)).resolves.toBe(true);

    await inbox.insert(n); // Kafka redelivery with the same derived id

    expect((await inbox.listByUser(a, u, 10)).items).toEqual([
      expect.objectContaining({ id: n.id, read: true }),
    ]);
  });

  it("the digest reads each pair's own inbox and stops for a removed membership", async () => {
    const [a, b, u, v, w] = [generateId(), generateId(), generateId(), generateId(), generateId()];
    // Stamped in the past, so a later remove (stamped now) wins.
    const updatedAt = new Date(Date.now() - 60_000);
    const pairs: [string, string, string][] = [
      [a, u, 'u@a.example'],
      [b, u, 'u@b.example'],
      [a, v, 'v@a.example'],
      [a, w, 'w@a.example'], // a recipient with nothing unread
    ];
    for (const [tenantId, userId, email] of pairs) {
      await recipients.upsert({ tenantId, userId, email, displayName: 'Member', updatedAt });
    }
    const n1 = notification(a, u, 'digest-n1');
    const n2 = notification(b, u, 'digest-n2');
    const n3 = notification(a, v, 'digest-n3');
    for (const n of [n1, n2, n3]) await inbox.insert(n);

    const sent: MailMessage[] = [];
    const mail = createMock<MailService>({
      enqueue: async (message: MailMessage) => {
        sent.push(message);
        return { jobId: message.idempotencyKey ?? 'job' };
      },
    });
    const digest = new SendDailyDigestHandler(recipients, inbox, asClass(mail));
    const ours = (messages: MailMessage[]) =>
      messages.filter(({ idempotencyKey = '' }) => [a, b].some((t) => idempotencyKey.includes(t)));
    const titlesOf = (message: MailMessage | undefined): unknown =>
      (message?.context['items'] as { title: string }[] | undefined)?.map((item) => item.title);

    const today = new Date('2026-09-29T09:00:00.000Z');
    await digest.execute(new SendDailyDigestCommand({ now: today, maxRecipients: 10_000 }));

    const firstRun = ours(sent);
    expect(firstRun).toHaveLength(3);
    const byKey = (tenantId: string, userId: string, day: string) =>
      firstRun.find((m) => m.idempotencyKey === `digest-${tenantId}-${userId}-${day}`);
    expect(titlesOf(byKey(a, u, '2026-09-29'))).toEqual(['digest-n1']);
    expect(titlesOf(byKey(b, u, '2026-09-29'))).toEqual(['digest-n2']);
    expect(titlesOf(byKey(a, v, '2026-09-29'))).toEqual(['digest-n3']);
    expect(byKey(a, u, '2026-09-29')?.to).toBe('u@a.example');
    expect(byKey(b, u, '2026-09-29')?.to).toBe('u@b.example');

    await recipients.remove(a, u);
    sent.length = 0;
    await digest.execute(
      new SendDailyDigestCommand({
        now: new Date('2026-09-30T09:00:00.000Z'),
        maxRecipients: 10_000,
      }),
    );

    const keys = ours(sent).map((m) => m.idempotencyKey);
    expect(keys).not.toContain(`digest-${a}-${u}-2026-09-30`);
    expect(keys.sort()).toEqual(
      [`digest-${b}-${u}-2026-09-30`, `digest-${a}-${v}-2026-09-30`].sort(),
    );
  });
});
