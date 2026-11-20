import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { TransactionHost } from '@platform/database';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AiDatabase, startAiDatabase } from '../../../test/ai-database.js';
import type { UsageRecord } from '../../domain/ai.types.js';
import { makeConversation, makeMessage } from '../../testing/ai-fixtures.js';
import { describeAiRepositoriesContract } from '../../testing/ai-repositories.contract.test.js';
import { usage } from './ai.schema.js';
import { DrizzleConversationsRepository } from './drizzle-conversations.repository.js';
import { DrizzleMessagesRepository } from './drizzle-messages.repository.js';
import { DrizzleUsageRepository } from './drizzle-usage.repository.js';

/*
 * The ai repositories on the roles of production: the real DatabaseModule on the three URLs of
 * startRlsTestPostgres (Citus 14.2, local execution off), migrations as app_owner, the app as
 * app_runtime under the forced RLS. The shared contract (src/testing) runs every method as the
 * owner, as another user of the tenant, as the same user in another tenant and without a
 * principal; the in-memory twins pass the same contract. Assertions past RLS go through the
 * superuser.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project ai:int ai.repositories.rls
 */
describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'ai repositories under RLS (app_runtime, Citus, local execution off)',
  () => {
    let database: AiDatabase | undefined;
    const db = () => database ?? expect.fail('no database');

    beforeAll(async () => {
      database = await startAiDatabase([
        DrizzleConversationsRepository,
        DrizzleMessagesRepository,
        DrizzleUsageRepository,
      ]);
    });

    afterAll(async () => {
      await database?.close();
    });

    it('the app runs as app_runtime', async () => {
      const [row] = await db().db.execute<{ user: string }>(sql`select current_user as user`);
      expect(row).toEqual({ user: 'app_runtime' });
    });

    describeAiRepositoriesContract('Drizzle on Citus', () => ({
      conversations: db().app.get(DrizzleConversationsRepository),
      messages: db().app.get(DrizzleMessagesRepository),
      usage: db().app.get(DrizzleUsageRepository),
      usageRowsOf: async (tenantId): Promise<UsageRecord[]> =>
        db()
          .superuser.select()
          .from(usage)
          .where(eq(usage.tenantId, tenantId))
          .orderBy(asc(usage.id)),
    }));

    it('runs the repositories of one unit of work in one transaction (a failure rolls all back)', async () => {
      const tenantId = generateId();
      const principal = createPrincipal({ userId: generateId(), tenantId, roles: ['member'] });
      const conversations = db().app.get(DrizzleConversationsRepository);
      const messages = db().app.get(DrizzleMessagesRepository);
      const conversation = makeConversation({ tenantId, userId: principal.userId });
      const txHost = db().app.get(TransactionHost);

      await expect(
        runWithPrincipal(principal, () =>
          txHost.withTransaction(async () => {
            await conversations.create(conversation);
            await messages.append(makeMessage(conversation));
            throw new Error('the model call failed');
          }),
        ),
      ).rejects.toThrow('the model call failed');

      const rows = await db().superuser.execute<{ n: number }>(sql`
        select (select count(*)::int from ai.conversations where tenant_id = ${tenantId})
          + (select count(*)::int from ai.messages where tenant_id = ${tenantId}) as n`);
      expect(rows[0]).toEqual({ n: 0 });
    });
  },
);
