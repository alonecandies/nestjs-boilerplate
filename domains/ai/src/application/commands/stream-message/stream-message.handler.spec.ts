import { HttpStatus } from '@nestjs/common';
import {
  AiClient,
  AiDisabledError,
  AiInputTooLargeError,
  AiMetrics,
  AiModelNotAllowedError,
  AiUpstreamError,
} from '@platform/ai';
import {
  aiTestConfig,
  MockAiModelProvider,
  type MockModelCall,
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
  traceRepositories,
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

type PromptMessage = MockModelCall['prompt'][number];
/** The text of a message as the model received it (a text-only prompt has nothing else). */
const textOf = (message: PromptMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
const charsSent = (prompt: readonly PromptMessage[]): number =>
  prompt.reduce((total, message) => total + textOf(message).length, 0);

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
    const repositories = traceRepositories(db, tx);
    const handler = new StreamMessageHandler(
      repositories.conversations,
      repositories.messages,
      repositories.usage,
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
    return { handler, provider, stream, calls: repositories.calls };
  }

  const assistantReplies = () => db.store.messages.filter((m) => m.role === 'assistant');
  /** The conversation's rows in order: role, text, status and the key each holds. */
  const rows = () =>
    db.store.messages
      .filter((m) => m.conversationId === conversation.id)
      .toSorted((a, b) => (a.id < b.id ? -1 : 1))
      .map((m) => [m.role, m.content, m.status, m.idempotencyKey]);
  /** What a model call received: each message's role and text. */
  const promptSent = (call: MockModelCall | undefined) =>
    (call?.prompt ?? []).map((m) => [m.role, textOf(m)]);

  /**
   * A turn on 'Tell me everything' cut after its first delta 'partial ' (the consumer stops
   * reading, as when the client leaves): the partial reply is stored as `incomplete`.
   */
  async function cut(request: Partial<StreamMessageRequest> = {}): Promise<void> {
    const model = mockHangingModel(['partial ']);
    const { handler } = setup(model);
    await as(ADA, async () => {
      const events = await handler.execute(
        new StreamMessageCommand({
          ...ADA,
          conversationId: conversation.id,
          content: 'Tell me everything',
          ...request,
        }),
      );
      for await (const event of events) {
        expect(event).toEqual({ type: 'delta', text: 'partial ' });
        break;
      }
    });
    await model.aborted;
  }

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

  it('stores the end under a lock: the conversation is read FOR UPDATE first, then the rows', async () => {
    const { stream, calls } = setup(mockStreamModel(['Row', '-level']));
    const { error } = await stream();
    expect(error).toBeUndefined();
    // The read before the call (unit 1), then the write (unit 2), whose first statement locks the
    // conversation: a delete cannot commit between that check and `touch`.
    expect(calls).toEqual([
      '1 conversations.findById',
      '1 messages.listRecent',
      '2 conversations.findByIdForUpdate',
      '2 messages.append',
      '2 messages.append',
      '2 usage.record',
      '2 conversations.touch',
    ]);
  });

  it('drops the oldest history to fit AI_MAX_INPUT_CHARS: a full conversation streams a short message', async () => {
    // Ten 100-character messages fill the 1000-character cap on their own.
    const history = Array.from({ length: 10 }, (_, i) => `old ${i} `.padEnd(100, '.'));
    for (const content of history) {
      await as(ADA, () => db.messages.append(makeMessage(conversation, { content })));
    }
    const model = mockStreamModel(['ok']);
    const { stream } = setup(model, {
      maxInputChars: 1_000,
      historyMaxMessages: 50,
      historyMaxTokens: 100_000,
    });

    const { events, error } = await stream();

    expect(error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'done', message: { content: 'ok' } });
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    // The oldest message made room: the nine newest, oldest first, then the new message.
    expect(prompt.map(textOf)).toEqual([...history.slice(1), 'What is RLS?']);
    expect(charsSent(prompt)).toBeLessThanOrEqual(1_000);
  });

  it('still refuses a new message over AI_MAX_INPUT_CHARS on its own: 422 before any event', async () => {
    await as(ADA, () => db.messages.append(makeMessage(conversation, { content: 'Hi' })));
    const model = mockStreamModel(['fits']);
    const { stream } = setup(model, { maxInputChars: 1_000 });

    const error = await stream({ content: 'x'.repeat(1_001) }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiInputTooLargeError);
    expect(error).toMatchObject({
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      details: { maxInputChars: 1_000 },
    });
    expect(model.doStreamCalls).toEqual([]);
    expect(db.store.messages.map((m) => m.content)).toEqual(['Hi']);
    expect(db.store.usage).toEqual([]);

    // A message that fits on its own goes, with no room left for any history.
    const { error: none } = await stream({ content: 'x'.repeat(1_000) });
    expect(none).toBeUndefined();
    expect(model.doStreamCalls[0]?.prompt.map(textOf)).toEqual(['x'.repeat(1_000)]);
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
      // Only a complete reply binds the key: the cut one leaves it free for a retry.
      idempotencyKey: null,
      requestHash: null,
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

  /** A client that disconnects while the turn reads the conversation (`prepare`). */
  function disconnectDuringPrepare(): AbortSignal {
    const client = new AbortController();
    const findById = db.conversations.findById.bind(db.conversations);
    db.conversations.findById = async (...args) => {
      client.abort();
      return findById(...args);
    };
    return client.signal;
  }
  /** `ai_requests_total` samples so far: a turn that makes no model call adds none. */
  const requestsCounted = async () =>
    (await metrics.requests.get()).values.reduce((total, sample) => total + sample.value, 0);

  it('a client that disconnects during prepare ends the stream at once with no model call and nothing stored', async () => {
    const model = mockHangingModel(['never']);
    const { handler } = setup(model);
    const signal = disconnectDuringPrepare();
    const counted = await requestsCounted();

    const outcome = await as(ADA, async () => {
      const events = await handler.execute(
        new StreamMessageCommand({
          ...ADA,
          conversationId: conversation.id,
          content: 'Go',
          idempotencyKey: 'stream-0009',
          signal,
        }),
      );
      return Promise.race([
        drain(events),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
      ]);
    });

    expect(outcome).not.toBe('hung');
    // The drained stream (SSE, GraphQL over HTTP) rejects with the client's abort reason.
    expect(outcome).toMatchObject({ events: [], error: signal.reason });
    // Nothing was sent: no model call, no metric, no message and no usage row.
    expect(model.doStreamCalls).toEqual([]);
    expect(await requestsCounted()).toBe(counted);
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage).toEqual([]);
  });

  it('a stream released before its first read after a disconnect during prepare calls no model', async () => {
    const model = mockHangingModel(['never']);
    const { handler } = setup(model);
    const signal = disconnectDuringPrepare();
    const counted = await requestsCounted();

    await as(ADA, async () => {
      const events = await handler.execute(
        new StreamMessageCommand({
          ...ADA,
          conversationId: conversation.id,
          content: 'Go',
          signal,
        }),
      );
      // The gRPC controller's shape: the call is already closed, so it releases the stream unread.
      await events[Symbol.asyncIterator]().return?.();
    });
    // A model call started at execute() would be a chain of microtasks over in-memory fakes:
    // one macrotask turn runs all of them first, so no wall-clock wait is needed.
    await new Promise((resolve) => setImmediate(resolve));

    expect(model.doStreamCalls).toEqual([]);
    expect(await requestsCounted()).toBe(counted);
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage).toEqual([]);
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

  it('a conversation deleted during the stream ends it with a 404 after the deltas and keeps only the usage row', async () => {
    const model = mockStreamModel(['Row', '-level'], {
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const { handler, calls } = setup(model);

    const { first, rest } = await as(ADA, async () => {
      const events = await handler.execute(
        new StreamMessageCommand({ ...ADA, conversationId: conversation.id, content: 'Go' }),
      );
      const iterator = events[Symbol.asyncIterator]();
      const head = await iterator.next(); // the call runs; nothing is stored yet
      await db.conversations.delete(TENANT, conversation.id);
      return { first: head, rest: await drain({ [Symbol.asyncIterator]: () => iterator }) };
    });

    expect(first).toEqual({ done: false, value: { type: 'delta', text: 'Row' } });
    expect(rest.events).toEqual([{ type: 'delta', text: '-level' }]);
    expect(rest.error).toMatchObject({
      code: AiChatErrorCode.CONVERSATION_NOT_FOUND,
      httpStatus: HttpStatus.NOT_FOUND,
    });
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage).toEqual([
      expect.objectContaining({
        ...ADA,
        conversationId: conversation.id,
        messageId: null,
        inputTokens: 12,
        outputTokens: 3,
        outcome: 'success',
      }),
    ]);
    // The locked read found nothing: the write recorded the usage only, and its unit committed.
    expect(calls.filter((call) => call.startsWith('2 '))).toEqual([
      '2 conversations.findByIdForUpdate',
      '2 usage.record',
    ]);
    expect(tx.rolledBack).toBe(0);
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

  it('a cut stream leaves its Idempotency-Key free: the retry runs a new turn, whose full reply then holds the key', async () => {
    await cut({ idempotencyKey: 'stream-0010' });
    const model = mockStreamModel(['The whole ', 'answer.']);
    const { stream, handler } = setup(model);

    const retry = await stream({ content: 'Tell me everything', idempotencyKey: 'stream-0010' });

    // A new turn, not a replay of the partial reply.
    expect(retry.error).toBeUndefined();
    expect(retry.events.slice(0, -1)).toEqual([
      { type: 'delta', text: 'The whole ' },
      { type: 'delta', text: 'answer.' },
    ]);
    const done = retry.events.at(-1);
    if (done?.type !== 'done') throw new Error('the retry did not end with done');
    expect(done.replayed).toBe(false);
    expect(done.message).toMatchObject({
      content: 'The whole answer.',
      status: 'complete',
      idempotencyKey: 'stream-0010',
    });
    // The question reached the model once: the cut exchange it repeats was left out.
    expect(model.doStreamCalls.map(promptSent)).toEqual([[['user', 'Tell me everything']]]);

    // The full reply holds the key now: the same body replays it, another body is a 409.
    const again = await stream({ content: 'Tell me everything', idempotencyKey: 'stream-0010' });
    expect(again.events).toEqual([
      { type: 'done', message: done.message, replayed: true, usage: null },
    ]);
    expect(model.doStreamCalls).toHaveLength(1);
    const reused = await as(ADA, () =>
      handler.execute(
        new StreamMessageCommand({
          ...ADA,
          conversationId: conversation.id,
          content: 'Another question',
          idempotencyKey: 'stream-0010',
        }),
      ),
    ).catch((e: unknown) => e);
    expect(reused).toMatchObject({
      code: AiChatErrorCode.IDEMPOTENCY_KEY_REUSED,
      httpStatus: HttpStatus.CONFLICT,
    });

    // Every row stays (both questions, the partial reply): only the full reply holds the key.
    expect(rows()).toEqual([
      ['user', 'Tell me everything', 'complete', null],
      ['assistant', 'partial ', 'incomplete', null],
      ['user', 'Tell me everything', 'complete', null],
      ['assistant', 'The whole answer.', 'complete', 'stream-0010'],
    ]);
    expect(db.store.usage.map((u) => u.outcome)).toEqual(['aborted', 'success']);
  });

  it('a retry of a cut question sends it once, and later turns never see the cut exchange it repeats', async () => {
    await cut(); // no key: the history rule holds for any retry
    const model = mockStreamModel(['Everything.']);
    const { stream } = setup(model);

    expect((await stream({ content: 'Tell me everything' })).error).toBeUndefined();
    expect((await stream({ content: 'And then?' })).error).toBeUndefined();

    expect(model.doStreamCalls.map(promptSent)).toEqual([
      [['user', 'Tell me everything']],
      [
        ['user', 'Tell me everything'],
        ['assistant', 'Everything.'],
        ['user', 'And then?'],
      ],
    ]);
  });

  it('a cut exchange the next message does not repeat stays in the history, so the model can go on', async () => {
    await cut();
    const model = mockStreamModel(['…and the rest.']);
    const { stream } = setup(model);

    expect((await stream({ content: 'Go on from there' })).error).toBeUndefined();

    expect(model.doStreamCalls.map(promptSent)).toEqual([
      [
        ['user', 'Tell me everything'],
        ['assistant', 'partial '],
        ['user', 'Go on from there'],
      ],
    ]);
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
