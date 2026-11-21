import { HttpStatus } from '@nestjs/common';
import {
  AiClient,
  AiDisabledError,
  AiMetrics,
  AiModelNotAllowedError,
  AiUpstreamError,
} from '@platform/ai';
import {
  aiTestConfig,
  MockAiModelProvider,
  mockFailingModel,
  mockHangingModel,
  mockStreamModel,
} from '@platform/ai/testing';
import { createPrincipal, runWithPrincipal } from '@platform/common';
import type { AiConfig } from '@platform/config';
import { APICallError, type LanguageModel } from 'ai';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  installTestTransactionHost,
  type TestTransactions,
} from '../../../../test/ai-test.utils.js';
import { AiChatErrorCode } from '../../../ai.constants.js';
import type { Conversation } from '../../../domain/ai.types.js';
import { makeConversation, makeMessage } from '../../../testing/ai-fixtures.js';
import {
  createInMemoryAiPersistence,
  type InMemoryAiPersistence,
} from '../../../testing/in-memory-ai.js';
import type { ChatStreamEvent, StreamMessageRequest } from '../../ports/ai.port.js';
import { StreamMessageCommand } from './stream-message.command.js';
import { StreamMessageHandler } from './stream-message.handler.js';

const TENANT = '0198f0a0-0000-7000-8000-000000000001';
const ADA = { tenantId: TENANT, userId: '0198f0a0-0000-7000-8000-0000000000a1' };
const BOB = { tenantId: TENANT, userId: '0198f0a0-0000-7000-8000-0000000000b2' };
const metrics = new AiMetrics();

const as = <T>(owner: { tenantId: string; userId: string }, fn: () => Promise<T>): Promise<T> =>
  runWithPrincipal(createPrincipal({ ...owner, roles: ['member'] }), fn);

/** Reads every event; a failure mid-stream is returned with the events before it. */
async function drain(
  events: AsyncIterable<ChatStreamEvent>,
): Promise<{ events: ChatStreamEvent[]; error?: unknown }> {
  const seen: ChatStreamEvent[] = [];
  try {
    for await (const event of events) seen.push(event);
    return { events: seen };
  } catch (error) {
    return { events: seen, error };
  }
}

describe('StreamMessageHandler', () => {
  let db: InMemoryAiPersistence;
  let tx: TestTransactions;
  let conversation: Conversation;

  function setup(model: LanguageModel, config: Partial<AiConfig> = {}) {
    const fullConfig = aiTestConfig(config);
    const provider = new MockAiModelProvider(model);
    const handler = new StreamMessageHandler(
      db.conversations,
      db.messages,
      db.usage,
      new AiClient(fullConfig, provider, metrics),
      fullConfig,
    );
    /** Starts the turn and reads it to the end, all as `owner` (the request's CLS context). */
    const stream = (request: Partial<StreamMessageRequest> = {}, owner = ADA) =>
      as(owner, async () =>
        drain(
          await handler.execute(
            new StreamMessageCommand({
              ...owner,
              conversationId: conversation.id,
              content: 'What is RLS?',
              ...request,
            }),
          ),
        ),
      );
    return { handler, provider, stream };
  }

  const assistantReplies = () => db.store.messages.filter((m) => m.role === 'assistant');

  beforeEach(async () => {
    db = createInMemoryAiPersistence();
    tx = installTestTransactionHost(db.store);
    conversation = makeConversation(ADA, { model: 'mock/default' });
    await as(ADA, () => db.conversations.create(conversation));
  });

  it('streams the deltas in order, then done with the stored reply and usage', async () => {
    const model = mockStreamModel(['Row', '-level ', 'security.'], {
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const { stream } = setup(model);
    await as(ADA, () =>
      db.messages.append(makeMessage(conversation, { role: 'user', content: 'Hi' })),
    );

    const { events, error } = await stream({ idempotencyKey: 'stream-0001' });

    expect(error).toBeUndefined();
    expect(events.slice(0, -1)).toEqual([
      { type: 'delta', text: 'Row' },
      { type: 'delta', text: '-level ' },
      { type: 'delta', text: 'security.' },
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      replayed: false,
      usage: { inputTokens: 12, outputTokens: 3 },
      message: {
        role: 'assistant',
        content: 'Row-level security.',
        status: 'complete',
        model: 'mock/default',
        inputTokens: 12,
        outputTokens: 3,
        idempotencyKey: 'stream-0001',
      },
    });
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((m) => m.role)).toEqual(['user', 'user']);
    expect(JSON.stringify(prompt.at(-1))).toContain('What is RLS?');
    const stored = db.store.messages
      .filter((m) => m.conversationId === conversation.id)
      .toSorted((a, b) => (a.id < b.id ? -1 : 1));
    expect(stored.map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'Hi', 'complete'],
      ['user', 'What is RLS?', 'complete'],
      ['assistant', 'Row-level security.', 'complete'],
    ]);
    expect(db.store.usage).toEqual([
      expect.objectContaining({
        ...ADA,
        messageId: done?.type === 'done' ? done.message.id : 'missing',
        inputTokens: 12,
        outputTokens: 3,
        outcome: 'success',
      }),
    ]);
    // Read before the call, write after it: two units of work, none open while streaming.
    expect(tx.begun).toBe(2);
  });

  it('a client that disconnects mid-stream aborts the upstream call; the partial reply is stored once as incomplete', async () => {
    const model = mockHangingModel(['partial ', 'answer']);
    const { handler } = setup(model);
    const client = new AbortController();

    const result = await as(ADA, async () => {
      const events = await handler.execute(
        new StreamMessageCommand({
          ...ADA,
          conversationId: conversation.id,
          content: 'Tell me everything',
          idempotencyKey: 'stream-0002',
          signal: client.signal,
        }),
      );
      const seen: ChatStreamEvent[] = [];
      try {
        for await (const event of events) {
          seen.push(event);
          if (seen.length === 2) client.abort();
        }
        return { seen, error: undefined };
      } catch (error) {
        return { seen, error };
      }
    });

    await expect(model.aborted).resolves.toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.seen).toEqual([
      { type: 'delta', text: 'partial ' },
      { type: 'delta', text: 'answer' },
    ]);
    const replies = assistantReplies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      content: 'partial answer',
      status: 'incomplete',
      model: 'mock/default',
      inputTokens: null,
      outputTokens: null,
      idempotencyKey: 'stream-0002',
    });
    expect(db.store.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'Tell me everything',
    ]);
    expect(db.store.usage.map((u) => [u.outcome, u.messageId])).toEqual([
      ['aborted', replies[0]?.id],
    ]);
  });

  it('a consumer that stops reading aborts the upstream call and stores the partial reply once', async () => {
    const model = mockHangingModel(['half']);
    const { handler } = setup(model);

    await as(ADA, async () => {
      const events = await handler.execute(
        new StreamMessageCommand({ ...ADA, conversationId: conversation.id, content: 'Go' }),
      );
      for await (const event of events) {
        expect(event).toEqual({ type: 'delta', text: 'half' });
        break; // return(): the generator's cleanup runs
      }
    });

    await expect(model.aborted).resolves.toBeUndefined();
    expect(assistantReplies().map((m) => [m.content, m.status])).toEqual([['half', 'incomplete']]);
    expect(db.store.usage.map((u) => u.outcome)).toEqual(['aborted']);
  });

  it('an abort before the first token stores no message and records the usage as aborted', async () => {
    const model = mockHangingModel([]);
    const { handler } = setup(model);
    const client = new AbortController();

    const outcome = await as(ADA, async () => {
      const events = await handler.execute(
        new StreamMessageCommand({
          ...ADA,
          conversationId: conversation.id,
          content: 'Go',
          signal: client.signal,
        }),
      );
      setTimeout(() => client.abort(), 20);
      return drain(events);
    });

    expect(outcome.events).toEqual([]);
    expect(outcome.error).toBeDefined();
    await expect(model.aborted).resolves.toBeUndefined();
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage.map((u) => [u.outcome, u.messageId])).toEqual([['aborted', null]]);
  });

  it('a client that disconnects during prepare ends the stream at once and stores no message', async () => {
    const model = mockHangingModel(['never']);
    const { handler } = setup(model);
    const client = new AbortController();
    const findById = db.conversations.findById.bind(db.conversations);
    db.conversations.findById = async (...args) => {
      client.abort();
      return findById(...args);
    };

    const outcome = await as(ADA, async () => {
      const events = await handler.execute(
        new StreamMessageCommand({
          ...ADA,
          conversationId: conversation.id,
          content: 'Go',
          idempotencyKey: 'stream-0009',
          signal: client.signal,
        }),
      );
      return Promise.race([
        drain(events),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
      ]);
    });

    expect(outcome).not.toBe('hung');
    expect(outcome).toMatchObject({ events: [], error: expect.anything() });
    expect(db.store.messages).toEqual([]);
    // Like any abort before the first token: no message, one usage row recorded as aborted.
    expect(db.store.usage.map((u) => [u.outcome, u.messageId])).toEqual([['aborted', null]]);
  });

  it('an upstream failure before any token ends the stream with AI_UPSTREAM_ERROR and stores no message', async () => {
    const upstream = new APICallError({
      message: 'boom',
      url: 'https://openrouter.invalid/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: false,
    });
    const { error, events } = await setup(mockFailingModel(upstream)).stream();

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(AiUpstreamError);
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage.map((u) => [u.outcome, u.messageId])).toEqual([['error', null]]);
  });

  it('replays an Idempotency-Key as a single done event without a model call; another body is 409', async () => {
    const model = mockStreamModel(['first']);
    const { stream, handler } = setup(model);
    const first = await stream({ idempotencyKey: 'stream-0003' });
    const firstDone = first.events.at(-1);

    const again = await stream({ idempotencyKey: 'stream-0003' });

    expect(again.events).toEqual([
      {
        type: 'done',
        replayed: true,
        usage: null,
        message: firstDone?.type === 'done' ? firstDone.message : undefined,
      },
    ]);
    expect(model.doStreamCalls).toHaveLength(1);
    const reused = await as(ADA, () =>
      handler.execute(
        new StreamMessageCommand({
          ...ADA,
          conversationId: conversation.id,
          content: 'Another question',
          idempotencyKey: 'stream-0003',
        }),
      ),
    ).catch((e: unknown) => e);
    expect(reused).toMatchObject({
      code: AiChatErrorCode.IDEMPOTENCY_KEY_REUSED,
      httpStatus: HttpStatus.CONFLICT,
    });
  });

  it('refuses before returning a stream: 404 for another user, 422 for a disallowed model, 503 disabled', async () => {
    const model = mockStreamModel(['never']);
    const { handler } = setup(model);
    const start = (request: Partial<StreamMessageRequest>, owner = ADA) =>
      as(owner, () =>
        handler.execute(
          new StreamMessageCommand({
            ...owner,
            conversationId: conversation.id,
            content: 'x',
            ...request,
          }),
        ),
      ).catch((e: unknown) => e);

    expect(await start({}, BOB)).toMatchObject({
      code: AiChatErrorCode.CONVERSATION_NOT_FOUND,
      httpStatus: HttpStatus.NOT_FOUND,
    });
    expect(await start({ model: 'evil/model' })).toBeInstanceOf(AiModelNotAllowedError);
    const disabled = setup(model, { enabled: false });
    const refused = await as(ADA, () =>
      disabled.handler.execute(
        new StreamMessageCommand({ ...ADA, conversationId: conversation.id, content: 'x' }),
      ),
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AiDisabledError);
    expect(refused).toMatchObject({ httpStatus: HttpStatus.SERVICE_UNAVAILABLE });

    expect(model.doStreamCalls).toEqual([]);
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage).toEqual([]);
  });
});
