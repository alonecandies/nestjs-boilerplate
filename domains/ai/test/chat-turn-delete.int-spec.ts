import { HttpStatus } from '@nestjs/common';
import { AiClient, AiMetrics } from '@platform/ai';
import {
  aiTestConfig,
  MockAiModelProvider,
  mockStreamModel,
  mockTextModel,
} from '@platform/ai/testing';
import { createPrincipal, generateId, type Principal, runWithPrincipal } from '@platform/common';
import { buildRlsContextSql, RowCountMismatchError } from '@platform/database';
import type { LanguageModel } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import { noop } from 'lodash-es';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiChatErrorCode } from '../src/ai.constants.js';
import { SendMessageCommand } from '../src/application/commands/send-message/send-message.command.js';
import { SendMessageHandler } from '../src/application/commands/send-message/send-message.handler.js';
import { StreamMessageCommand } from '../src/application/commands/stream-message/stream-message.command.js';
import { StreamMessageHandler } from '../src/application/commands/stream-message/stream-message.handler.js';
import type { ChatStreamEvent, SendMessageResult } from '../src/application/ports/ai.port.js';
import type { MessagesRepository } from '../src/application/repositories/messages.repository.js';
import type { Conversation, Message } from '../src/domain/ai.types.js';
import { conversations, messages, usage } from '../src/infrastructure/persistence/ai.schema.js';
import { DrizzleConversationsRepository } from '../src/infrastructure/persistence/drizzle-conversations.repository.js';
import { DrizzleMessagesRepository } from '../src/infrastructure/persistence/drizzle-messages.repository.js';
import { DrizzleUsageRepository } from '../src/infrastructure/persistence/drizzle-usage.repository.js';
import { makeConversation } from '../src/testing/ai-fixtures.js';
import { type AiDatabase, startAiDatabase } from './ai-database.js';

/*
 * A chat turn racing the delete of its conversation, on the roles of production: the handlers over
 * the Drizzle repositories as app_runtime (startAiDatabase: Citus 14.2, local execution off), and
 * the delete as the same owner on a second app_runtime connection outside the app's pool, so the
 * two transactions are real and their row locks meet on the shard. The mock model is held at its
 * call, so the delete lands between the call and the turn's write. The in-memory twins have no
 * concurrent transactions, so only this spec can show the lock. Rows are read as the superuser.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project ai:int chat-turn-delete
 */

const metrics = new AiMetrics();
const USAGE = { inputTokens: 21, outputTokens: 4 };
/** How long to wait for a blocked statement; app_runtime's statement_timeout is 15 s. */
const LOCK_WAIT_TIMEOUT_MS = 10_000;

type Kind = 'send' | 'stream';

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** How a turn ended: the send result or the streamed events, and the error it threw, if any. */
interface TurnOutcome {
  readonly result?: SendMessageResult;
  readonly events?: ChatStreamEvent[];
  readonly error?: unknown;
}

/** A text answer for `kind`, held at its call until `release` opens; `called` opens on the call. */
function heldModel(kind: Kind, release: Gate, called: Gate): LanguageModel {
  const model =
    kind === 'send'
      ? mockTextModel('Too late.', USAGE)
      : mockStreamModel(['Too ', 'late.'], { usage: USAGE });
  const generate = model.doGenerate.bind(model);
  const stream = model.doStream.bind(model);
  model.doGenerate = async (options) => {
    called.open();
    await release.opened;
    return generate(options);
  };
  model.doStream = async (options) => {
    called.open();
    await release.opened;
    return stream(options);
  };
  return model;
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'a chat turn racing the delete of its conversation (app_runtime, Citus, local execution off)',
  () => {
    let db: AiDatabase | undefined;
    /** The second app_runtime connection: the delete's own transaction, beside the app's pool. */
    let deleter: Sql | undefined;
    const database = () => db ?? expect.fail('no database');
    const app = () => database().app;

    beforeAll(async () => {
      db = await startAiDatabase([
        DrizzleConversationsRepository,
        DrizzleMessagesRepository,
        DrizzleUsageRepository,
      ]);
      deleter = postgres(db.pg.runtimeUrl, { max: 1, onnotice: noop });
    });

    afterAll(async () => {
      await deleter?.end({ timeout: 5 });
      await db?.close();
    });

    /** A conversation of a new user in a new tenant, created through the app as its owner. */
    async function seed(): Promise<{ owner: Principal; conversation: Conversation }> {
      const tenantId = generateId();
      const owner = createPrincipal({ userId: generateId(), tenantId, roles: ['member'] });
      const conversation = makeConversation(
        { tenantId, userId: owner.userId },
        { model: 'mock/default' },
      );
      await runWithPrincipal(owner, () =>
        app().get(DrizzleConversationsRepository).create(conversation),
      );
      return { owner, conversation };
    }

    /** One turn of `kind` as the owner, to its end, over the app's repositories and `model`. */
    async function turn(
      kind: Kind,
      owner: Principal,
      conversation: Conversation,
      model: LanguageModel,
      messageStore: MessagesRepository = app().get(DrizzleMessagesRepository),
    ): Promise<TurnOutcome> {
      const config = aiTestConfig({ requestTimeoutMs: 30_000 });
      const client = new AiClient(config, new MockAiModelProvider(model), metrics);
      const deps = [
        app().get(DrizzleConversationsRepository),
        messageStore,
        app().get(DrizzleUsageRepository),
        client,
        config,
      ] as const;
      const request = {
        tenantId: conversation.tenantId,
        userId: owner.userId,
        conversationId: conversation.id,
        content: 'What is RLS?',
      };
      return runWithPrincipal(owner, async (): Promise<TurnOutcome> => {
        if (kind === 'send') {
          try {
            return {
              result: await new SendMessageHandler(...deps).execute(
                new SendMessageCommand(request),
              ),
            };
          } catch (error) {
            return { error };
          }
        }
        const events: ChatStreamEvent[] = [];
        try {
          const stream = await new StreamMessageHandler(...deps).execute(
            new StreamMessageCommand(request),
          );
          for await (const event of stream) events.push(event);
          return { events };
        } catch (error) {
          return { events, error };
        }
      });
    }

    /**
     * Deletes the conversation as its owner on the second connection, as
     * `DrizzleConversationsRepository.delete` does (the conversation, then its messages). With
     * `commit`, the transaction stays open until it opens: the row lock is held and the delete is
     * not yet visible. `held` resolves once both statements ran; `done` with the conversations
     * deleted, once committed.
     */
    function remove(
      owner: Principal,
      conversation: Conversation,
      commit?: Gate,
    ): { held: Promise<void>; done: Promise<number> } {
      const { tenantId, id } = conversation;
      const held = gate();
      const done = (deleter ?? expect.fail('no deleter')).begin(async (tx) => {
        await tx.unsafe(buildRlsContextSql({ userId: owner.userId, tenantId })).simple();
        const deleted = await tx`delete from ai.conversations
          where tenant_id = ${tenantId} and id = ${id} returning id`;
        await tx`delete from ai.messages where tenant_id = ${tenantId} and conversation_id = ${id}`;
        held.open();
        await commit?.opened;
        return deleted.length;
      });
      return { held: Promise.race([held.opened, done.then(noop)]), done };
    }

    /**
     * Resolves once a statement on ai.conversations waits for a lock. With local execution off the
     * waiter is the shard backend Citus opened for the statement, not the app's session, so the
     * whole node is read, as the superuser.
     */
    async function lockWaitSeen(): Promise<void> {
      const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const [row] = await database().superuser.execute<{ waiting: number }>(sql`
          select count(*)::int as waiting from pg_locks l join pg_stat_activity a using (pid)
          where not l.granted and a.query like '%ai.conversations%'`);
        if ((row?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no statement on ai.conversations waited within ${LOCK_WAIT_TIMEOUT_MS} ms`);
    }

    /** The conversation's rows, read past RLS. */
    async function rowsOf({ tenantId, id }: Conversation) {
      const { superuser } = database();
      return {
        conversations: await superuser
          .select()
          .from(conversations)
          .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, id))),
        messages: await superuser
          .select()
          .from(messages)
          .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, id))),
        usage: await superuser
          .select()
          .from(usage)
          .where(and(eq(usage.tenantId, tenantId), eq(usage.conversationId, id))),
      };
    }

    it.each(['send', 'stream'] as const)(
      '%s: a delete during the call that commits while the turn writes: 404, the usage row kept',
      async (kind) => {
        const { owner, conversation } = await seed();
        const called = gate();
        const release = gate();
        const commit = gate();
        let pending: Promise<TurnOutcome> | undefined;
        let deletion: ReturnType<typeof remove> | undefined;
        try {
          pending = turn(kind, owner, conversation, heldModel(kind, release, called));
          await called.opened; // the read before the call is done; the model is answering
          deletion = remove(owner, conversation, commit);
          await deletion.held; // deleted, not committed: the conversation's row is locked
          release.open(); // the answer arrives; the turn goes on to its write
          await lockWaitSeen(); // the write waits for the delete's row lock
          commit.open();
          await expect(deletion.done).resolves.toBe(1);
          const outcome = await pending;

          expect(outcome.error).not.toBeInstanceOf(RowCountMismatchError);
          expect(outcome.error).toMatchObject({
            code: AiChatErrorCode.CONVERSATION_NOT_FOUND,
            httpStatus: HttpStatus.NOT_FOUND,
          });
          expect(outcome.events).toEqual(
            kind === 'stream'
              ? [
                  { type: 'delta', text: 'Too ' },
                  { type: 'delta', text: 'late.' },
                ]
              : undefined,
          );
          const rows = await rowsOf(conversation);
          expect(rows.conversations).toEqual([]);
          expect(rows.messages).toEqual([]);
          expect(rows.usage).toEqual([
            expect.objectContaining({
              userId: owner.userId,
              messageId: null,
              outcome: 'success',
              ...USAGE,
            }),
          ]);
        } finally {
          release.open();
          commit.open();
          await Promise.allSettled([pending, deletion?.done]);
        }
      },
    );

    it('send: a delete that comes while the turn writes waits for it, then takes its messages', async () => {
      const { owner, conversation } = await seed();
      const locked = gate();
      const resume = gate();
      const real = app().get(DrizzleMessagesRepository);
      // Holds the write after its first statement (the conversation's lock), before any insert.
      const paused: MessagesRepository = Object.assign(
        Object.create(real) as DrizzleMessagesRepository,
        {
          append: async (message: Message) => {
            locked.open();
            await resume.opened;
            return real.append(message);
          },
        },
      );
      let pending: Promise<TurnOutcome> | undefined;
      let deletion: ReturnType<typeof remove> | undefined;
      try {
        pending = turn('send', owner, conversation, mockTextModel('In time.', USAGE), paused);
        await locked.opened;
        deletion = remove(owner, conversation);
        const first = await Promise.race([
          lockWaitSeen().then(() => 'the delete waits'),
          deletion.done.then(() => 'the delete committed first'),
        ]);
        expect(first).toBe('the delete waits');
        resume.open();
        const outcome = await pending;
        await expect(deletion.done).resolves.toBe(1);

        expect(outcome.error).toBeUndefined();
        expect(outcome.result).toMatchObject({
          replayed: false,
          message: { role: 'assistant', content: 'In time.' },
        });
        const rows = await rowsOf(conversation);
        // The delete ran once the turn committed: the conversation and all its messages are gone.
        expect(rows.conversations).toEqual([]);
        expect(rows.messages).toEqual([]);
        expect(rows.usage).toEqual([
          expect.objectContaining({
            messageId: outcome.result?.message.id,
            outcome: 'success',
            ...USAGE,
          }),
        ]);
      } finally {
        resume.open();
        await Promise.allSettled([pending, deletion?.done]);
      }
    });
  },
);
