import { HttpStatus } from '@nestjs/common';
import {
  AiClient,
  AiDisabledError,
  AiInputTooLargeError,
  AiMetrics,
  AiModelNotAllowedError,
  AiTimeoutError,
  AiUpstreamError,
} from '@platform/ai';
import {
  aiTestConfig,
  MockAiModelProvider,
  type MockModelCall,
  mockFailingModel,
  mockHangingModel,
  mockTextModel,
} from '@platform/ai/testing';
import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import type { AiConfig } from '@platform/config';
import type { LanguageModel } from 'ai';
import { APICallError } from 'ai';
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
import type { SendMessageRequest } from '../../ports/ai.port.js';
import { SendMessageCommand } from './send-message.command.js';
import { SendMessageHandler } from './send-message.handler.js';

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

describe('SendMessageHandler', () => {
  let db: InMemoryAiPersistence;
  let tx: TestTransactions;
  let conversation: Conversation;

  function setup(model: LanguageModel, config: Partial<AiConfig> = {}) {
    const fullConfig = aiTestConfig(config);
    const provider = new MockAiModelProvider(model);
    const handler = new SendMessageHandler(
      db.conversations,
      db.messages,
      db.usage,
      new AiClient(fullConfig, provider, metrics),
      fullConfig,
    );
    const send = (request: Partial<SendMessageRequest> = {}, owner = ADA) =>
      as(owner, () =>
        handler.execute(
          new SendMessageCommand({
            ...owner,
            conversationId: conversation.id,
            content: 'What is RLS?',
            ...request,
          }),
        ),
      );
    return { handler, provider, send };
  }

  beforeEach(async () => {
    db = createInMemoryAiPersistence();
    tx = installTestTransactionHost(db.store);
    conversation = makeConversation(ADA, { model: 'mock/default' });
    await as(ADA, () => db.conversations.create(conversation));
  });

  it('sends the history then the user message, and stores the exchange, usage and updatedAt', async () => {
    const model = mockTextModel('Row-level security.', { inputTokens: 21, outputTokens: 4 });
    const { send } = setup(model);
    await as(ADA, () =>
      db.messages.append(makeMessage(conversation, { role: 'user', content: 'Hi' })),
    );

    const result = await send();

    expect(result.replayed).toBe(false);
    expect(result.message).toMatchObject({
      role: 'assistant',
      content: 'Row-level security.',
      status: 'complete',
      model: 'mock/default',
      inputTokens: 21,
      outputTokens: 4,
      conversationId: conversation.id,
      userId: ADA.userId,
    });
    const prompt = model.doGenerateCalls[0]?.prompt ?? [];
    expect(prompt.map((m) => m.role)).toEqual(['user', 'user']);
    expect(JSON.stringify(prompt.at(-1))).toContain('What is RLS?');
    // The conversation's order is the uuidv7 id order (the reply is inserted first, see store()).
    const stored = db.store.messages
      .filter((m) => m.conversationId === conversation.id)
      .toSorted((a, b) => (a.id < b.id ? -1 : 1));
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi'],
      ['user', 'What is RLS?'],
      ['assistant', 'Row-level security.'],
    ]);
    expect(db.store.usage).toEqual([
      expect.objectContaining({
        ...ADA,
        conversationId: conversation.id,
        messageId: result.message.id,
        model: 'mock/default',
        inputTokens: 21,
        outputTokens: 4,
        outcome: 'success',
      }),
    ]);
    const touched = db.store.conversations.get(`${TENANT}/${conversation.id}`);
    expect(touched?.updatedAt).toEqual(result.message.createdAt);
    // The read before the call and the writes after it: two units of work, none during the call.
    expect(tx.begun).toBe(2);
  });

  it('applies the history window by message count and approximate token budget', async () => {
    for (const content of ['one '.repeat(40), 'two', 'three', 'four']) {
      await as(ADA, () => db.messages.append(makeMessage(conversation, { content })));
    }
    const byCount = mockTextModel('ok');
    await setup(byCount, { historyMaxMessages: 2 }).send();
    expect(JSON.stringify(byCount.doGenerateCalls[0]?.prompt)).not.toContain('two');
    expect(
      byCount.doGenerateCalls[0]?.prompt.map((m) => JSON.stringify(m.content).includes('three')),
    ).toEqual([true, false, false]);

    const byTokens = mockTextModel('ok');
    // 'one '×40 is 40 tokens: a 30-token budget drops it, keeping everything newer.
    await setup(byTokens, { historyMaxMessages: 50, historyMaxTokens: 30 }).send({
      content: 'again',
    });
    const prompt = JSON.stringify(byTokens.doGenerateCalls[0]?.prompt);
    expect(prompt).not.toContain('one one');
    expect(prompt).toContain('four');
  });

  it('drops the oldest history to fit AI_MAX_INPUT_CHARS: a full conversation takes a short message', async () => {
    // Ten 100-character messages fill the 1000-character cap on their own.
    const history = Array.from({ length: 10 }, (_, i) => `old ${i} `.padEnd(100, '.'));
    for (const content of history) {
      await as(ADA, () => db.messages.append(makeMessage(conversation, { content })));
    }
    const model = mockTextModel('ok');
    const { send } = setup(model, {
      maxInputChars: 1_000,
      historyMaxMessages: 50,
      historyMaxTokens: 100_000,
    });

    const result = await send();

    expect(result).toMatchObject({ replayed: false, message: { content: 'ok' } });
    const prompt = model.doGenerateCalls[0]?.prompt ?? [];
    // The oldest message made room: the nine newest, oldest first, then the new message.
    expect(prompt.map(textOf)).toEqual([...history.slice(1), 'What is RLS?']);
    expect(charsSent(prompt)).toBeLessThanOrEqual(1_000);
  });

  it('still refuses a new message over AI_MAX_INPUT_CHARS on its own: 422 before any call', async () => {
    await as(ADA, () => db.messages.append(makeMessage(conversation, { content: 'Hi' })));
    const model = mockTextModel('fits');
    const { send } = setup(model, { maxInputChars: 1_000 });

    const error = await send({ content: 'x'.repeat(1_001) }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiInputTooLargeError);
    expect(error).toMatchObject({
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      details: { maxInputChars: 1_000 },
    });
    expect(model.doGenerateCalls).toEqual([]);
    expect(db.store.messages.map((m) => m.content)).toEqual(['Hi']);
    expect(db.store.usage).toEqual([]);

    // A message that fits on its own goes, with no room left for any history.
    await send({ content: 'x'.repeat(1_000) });
    expect(model.doGenerateCalls[0]?.prompt.map(textOf)).toEqual(['x'.repeat(1_000)]);
  });

  it('uses the requested model when allowed, and refuses another with 422 before any call', async () => {
    const model = mockTextModel('ok');
    const { send, provider } = setup(model);
    const reply = await send({ model: 'mock/other' });
    expect(reply.message.model).toBe('mock/other');
    expect(provider.requests.at(-1)?.model).toBe('mock/other');

    const error = await send({ model: 'evil/model' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiModelNotAllowedError);
    expect(error).toMatchObject({ httpStatus: HttpStatus.UNPROCESSABLE_ENTITY });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(db.store.usage).toHaveLength(1);
  });

  it('replays an Idempotency-Key with the stored reply and no second call', async () => {
    const model = mockTextModel('first answer');
    const { send } = setup(model);
    const first = await send({ idempotencyKey: 'msg-0001' });
    const again = await send({ idempotencyKey: 'msg-0001' });

    expect(again).toEqual({ message: first.message, replayed: true });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(db.store.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(db.store.messages.find((m) => m.role === 'assistant')).toMatchObject({
      idempotencyKey: 'msg-0001',
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('answers 409 when the same key comes with another body', async () => {
    const model = mockTextModel('first answer');
    const { send } = setup(model);
    await send({ idempotencyKey: 'msg-0002' });

    for (const changed of [{ content: 'Something else' }, { model: 'mock/other' }]) {
      const error = await send({ idempotencyKey: 'msg-0002', ...changed }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: AiChatErrorCode.IDEMPOTENCY_KEY_REUSED,
        httpStatus: HttpStatus.CONFLICT,
      });
    }
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('a concurrent replay that loses the race returns the winner reply and records its usage', async () => {
    const model = mockTextModel('answer');
    const { send } = setup(model);
    const [a, b] = await Promise.all([
      send({ idempotencyKey: 'msg-race' }),
      send({ idempotencyKey: 'msg-race' }),
    ]);
    expect(a.message.id).toBe(b.message.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(db.store.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(db.store.messages.filter((m) => m.content === 'What is RLS?')).toHaveLength(1);
    expect(db.store.usage.map((u) => u.messageId)).toEqual(
      expect.arrayContaining([a.message.id, null]),
    );
  });

  it('refuses with 503 while AI is disabled, before any read or call', async () => {
    const model = mockTextModel('never');
    const { send, provider } = setup(model, { enabled: false });
    const error = await send().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiDisabledError);
    expect(error).toMatchObject({ httpStatus: HttpStatus.SERVICE_UNAVAILABLE });
    expect(provider.requests).toEqual([]);
    expect(tx.begun).toBe(0);
    expect(db.store.usage).toEqual([]);
  });

  it('a failed call stores no message and records a usage row with the failure outcome', async () => {
    const upstream = new APICallError({
      message: 'boom',
      url: 'https://openrouter.invalid/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: false,
    });
    const error = await setup(mockFailingModel(upstream))
      .send()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUpstreamError);
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage).toEqual([
      expect.objectContaining({
        ...ADA,
        conversationId: conversation.id,
        messageId: null,
        model: 'mock/default',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        outcome: 'error',
      }),
    ]);
    expect(db.store.conversations.get(`${TENANT}/${conversation.id}`)?.updatedAt).toEqual(
      conversation.updatedAt,
    );
  });

  it('records a timeout as outcome timeout (504)', async () => {
    const error = await setup(mockHangingModel(), { requestTimeoutMs: 1_000 })
      .send()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiTimeoutError);
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage.map((u) => u.outcome)).toEqual(['timeout']);
  }, 10_000);

  it('is a 404 for another user’s conversation (nothing called, nothing written)', async () => {
    const model = mockTextModel('never');
    const { send } = setup(model);
    const error = await send({}, BOB).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: AiChatErrorCode.CONVERSATION_NOT_FOUND,
      httpStatus: HttpStatus.NOT_FOUND,
    });
    expect(model.doGenerateCalls).toEqual([]);
    expect(db.store.usage).toEqual([]);
  });

  it('a conversation deleted during the call stores no message, keeps the usage and answers 404', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = mockTextModel('late');
    const original = slow.doGenerate.bind(slow);
    slow.doGenerate = async (options) => {
      await gate;
      return original(options);
    };
    const pending = setup(slow)
      .send()
      .catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await as(ADA, () => db.conversations.delete(TENANT, conversation.id));
    release();
    expect(await pending).toMatchObject({ code: AiChatErrorCode.CONVERSATION_NOT_FOUND });
    expect(db.store.messages).toEqual([]);
    expect(db.store.usage.map((u) => [u.outcome, u.messageId])).toEqual([['success', null]]);
  });

  it('writes the exchange in one unit of work: a failing write leaves none of it', async () => {
    const { send } = setup(mockTextModel('answer'));
    db.usage.record = async () => {
      throw new Error('usage insert failed');
    };
    await expect(send()).rejects.toThrow('usage insert failed');
    expect(db.store.messages).toEqual([]);
    expect(tx.rolledBack).toBeGreaterThanOrEqual(1);
  });

  it('refuses a request for another tenant or user than the principal (403)', async () => {
    const { handler } = setup(mockTextModel('never'));
    const error = await as(ADA, () =>
      handler.execute(
        new SendMessageCommand({
          tenantId: TENANT,
          userId: BOB.userId,
          conversationId: generateId(),
          content: 'x',
        }),
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: AiChatErrorCode.TENANT_MISMATCH });
  });
});
