/*
 * The AI chat REST API in the monolith (AI plan Task 3): conversations, a non-streaming turn with
 * idempotent replay, ownership (404 for anyone else's), RBAC (`ai:chat`) and the `ai.chat` rate
 * limit per user and per tenant. The model is a mock (`MockAiModelProvider`); nothing reaches
 * OpenRouter. The ai repositories are the in-memory twins, which emulate the row-local policies.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    AI_ENABLED: 'true',
    OPENROUTER_API_KEY: 'sk-or-v1-e2e-key-never-sent',
    AI_DEFAULT_MODEL: 'mock/default',
    AI_ALLOWED_MODELS: 'mock/other',
    AI_CHAT_LIMIT: '4',
    AI_CHAT_TENANT_LIMIT: '6',
  });
});

import { signTestAccessToken } from '@platform/auth/testing';
import { generateId } from '@platform/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, expectProblem } from './support/http.js';
import {
  createMonolithE2eApp,
  E2E_AI_REPLY,
  type MonolithE2e,
} from './support/monolith-e2e-app.js';

interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string };
}
interface ConversationBody {
  id: string;
  title: string | null;
  model: string;
}
interface MessageBody {
  id: string;
  role: string;
  content: unknown;
  model: string | null;
}

describe('AI chat REST (monolith)', () => {
  let e2e: MonolithE2e;
  let ada: Tokens;
  let bob: Tokens;
  const inject = (...args: Parameters<MonolithE2e['app']['inject']>) => e2e.app.inject(...args);

  const register = async (email: string): Promise<Tokens> => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'correct horse battery staple', displayName: email },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Tokens>();
  };
  const createConversation = async (who: Tokens, payload: object = {}) => {
    const res = await inject({
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: bearer(who.accessToken),
      payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<ConversationBody>();
  };
  const send = (who: Tokens, conversationId: string, payload: object, key?: string) =>
    inject({
      method: 'POST',
      url: `/v1/ai/conversations/${conversationId}/messages`,
      headers: {
        ...bearer(who.accessToken),
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      payload,
    });

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    ada = await register('ada.ai@example.com');
    bob = await register('bob.ai@example.com');
  });
  beforeEach(async () => {
    await e2e.redis.flushall();
  });
  afterAll(async () => {
    await e2e?.app.close();
  });

  it('creates, lists, reads and deletes the caller’s conversations', async () => {
    const created = await createConversation(ada, { title: 'Trip plans' });
    expect(created).toMatchObject({ title: 'Trip plans', model: 'mock/default' });

    const list = await inject({
      method: 'GET',
      url: '/v1/ai/conversations?limit=50',
      headers: bearer(ada.accessToken),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ items: ConversationBody[] }>().items.map((c) => c.id)).toContain(created.id);

    const read = await inject({
      method: 'GET',
      url: `/v1/ai/conversations/${created.id}`,
      headers: bearer(ada.accessToken),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual({
      id: created.id,
      title: 'Trip plans',
      model: 'mock/default',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const removed = await inject({
      method: 'DELETE',
      url: `/v1/ai/conversations/${created.id}`,
      headers: bearer(ada.accessToken),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expectProblem(
      await inject({
        method: 'GET',
        url: `/v1/ai/conversations/${created.id}`,
        headers: bearer(ada.accessToken),
      }),
      404,
      'CONVERSATION_NOT_FOUND',
    );
  });

  it('refuses a model outside the allowlist (422) and an unknown body field (400)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: bearer(ada.accessToken),
      payload: { model: 'evil/model' },
    });
    expectProblem(res, 422, 'AI_MODEL_NOT_ALLOWED');
    const extra = await inject({
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: bearer(ada.accessToken),
      payload: { tenantId: generateId() },
    });
    expect(extra.statusCode, extra.body).toBe(400);
  });

  it('sends a message, stores the exchange and replays an Idempotency-Key', async () => {
    const conversation = await createConversation(ada);
    const first = await send(ada, conversation.id, { content: 'Hi there' }, 'e2e-msg-0001');
    expect(first.statusCode, first.body).toBe(201);
    const reply = first.json<{ message: MessageBody; replayed: boolean }>();
    expect(reply).toMatchObject({
      replayed: false,
      message: { role: 'assistant', content: E2E_AI_REPLY, model: 'mock/default' },
    });

    const again = await send(ada, conversation.id, { content: 'Hi there' }, 'e2e-msg-0001');
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()).toEqual({ ...reply, replayed: true });

    const changed = await send(ada, conversation.id, { content: 'Other' }, 'e2e-msg-0001');
    expectProblem(changed, 409, 'IDEMPOTENCY_KEY_REUSED');

    const messages = await inject({
      method: 'GET',
      url: `/v1/ai/conversations/${conversation.id}/messages`,
      headers: bearer(ada.accessToken),
    });
    expect(messages.statusCode, messages.body).toBe(200);
    expect(messages.json<{ items: MessageBody[] }>().items.map((m) => [m.role, m.content])).toEqual(
      [
        ['assistant', E2E_AI_REPLY],
        ['user', 'Hi there'],
      ],
    );
    const usage = e2e.ai.persistence.store.usage.filter(
      (u) => u.conversationId === conversation.id,
    );
    expect(usage).toEqual([
      expect.objectContaining({
        outcome: 'success',
        messageId: reply.message.id,
        userId: ada.user.id,
      }),
    ]);

    expectProblem(await send(ada, conversation.id, { content: 'x' }, 'bad key!'), 400);
  });

  it('another user sees none of it: 404 on read, messages and send', async () => {
    const conversation = await createConversation(ada);
    for (const request of [
      { method: 'GET' as const, url: `/v1/ai/conversations/${conversation.id}` },
      { method: 'GET' as const, url: `/v1/ai/conversations/${conversation.id}/messages` },
      { method: 'DELETE' as const, url: `/v1/ai/conversations/${conversation.id}` },
    ]) {
      expectProblem(
        await inject({ ...request, headers: bearer(bob.accessToken) }),
        404,
        'CONVERSATION_NOT_FOUND',
      );
    }
    expectProblem(
      await send(bob, conversation.id, { content: 'hijack' }),
      404,
      'CONVERSATION_NOT_FOUND',
    );
    expect(e2e.ai.persistence.store.messages.filter((m) => m.content === 'hijack')).toEqual([]);
  });

  it('403 without ai:chat (a token with no tenant role)', async () => {
    const { token } = await signTestAccessToken({
      id: ada.user.id,
      email: 'ada.ai@example.com',
      tenantId: ada.tenantId,
      roles: [],
    });
    for (const request of [
      { method: 'GET' as const, url: '/v1/ai/conversations' },
      { method: 'POST' as const, url: '/v1/ai/conversations', payload: {} },
    ]) {
      expectProblem(await inject({ ...request, headers: bearer(token) }), 403);
    }
  });

  it('429 from ai.chat: AI_CHAT_LIMIT per user, then AI_CHAT_TENANT_LIMIT per tenant', async () => {
    const conversation = await createConversation(ada);
    for (let i = 0; i < 4; i += 1) {
      const res = await send(ada, conversation.id, { content: `turn ${i}` });
      expect(res.statusCode, res.body).toBe(201);
      expect(String(res.headers['ratelimit-policy'])).toContain('"route:ai.chat";q=4;w=60');
      expect(String(res.headers['ratelimit-policy'])).toContain('"tenant:ai.chat";q=6;w=60');
    }
    const limited = await send(ada, conversation.id, { content: 'one more' });
    expectProblem(limited, 429, 'RATE_LIMITED');
    expect(String(limited.headers['ratelimit'])).toContain('"route:ai.chat";r=0');

    // A second member of Ada's tenant shares the tenant budget (4 of 6 spent): 2 more, then 429.
    const { token } = await signTestAccessToken({
      id: generateId(),
      email: 'carol.ai@example.com',
      tenantId: ada.tenantId,
      roles: ['member'],
    });
    const carol = { accessToken: token, tenantId: ada.tenantId, user: { id: '' } };
    const unknown = generateId();
    // The policy is charged before the handler: Carol's sends to an unknown conversation count.
    for (let i = 0; i < 2; i += 1) {
      expect((await send(carol, unknown, { content: 'hi' })).statusCode).toBe(404);
    }
    const tenantLimited = await send(carol, unknown, { content: 'hi' });
    expectProblem(tenantLimited, 429, 'RATE_LIMITED');
    expect(String(tenantLimited.headers['ratelimit'])).toContain('"tenant:ai.chat";r=0');

    // Bob's tenant is untouched.
    const bobs = await createConversation(bob);
    expect((await send(bob, bobs.id, { content: 'hello' })).statusCode).toBe(201);
  });
});
