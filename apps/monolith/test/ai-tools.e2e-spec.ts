/*
 * The AI chat tools in the monolith (AI plan Task 5): the model's read-only tools reach the real
 * identity, notifications and billing ports (local adapters, CQRS handlers) as the caller, so a
 * turn reads only the caller's own profile, inbox and payments. The model is a scripted mock that
 * calls every tool, then answers with the tool results it was sent; nothing reaches OpenRouter.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    AI_ENABLED: 'true',
    OPENROUTER_API_KEY: 'sk-or-v1-e2e-key-never-sent',
    AI_DEFAULT_MODEL: 'mock/default',
  });
});

import { type MockModelCall, mockScriptedModel } from '@platform/ai/testing';
import { generateId } from '@platform/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string };
}

/** The tool results the model was sent on this step, as JSON (the reply echoes them). */
const toolResultsOf = (call: MockModelCall): string =>
  JSON.stringify(
    call.prompt.flatMap((message) =>
      message.role === 'tool'
        ? message.content.flatMap((part) =>
            part.type === 'tool-result' ? [{ tool: part.toolName, output: part.output }] : [],
          )
        : [],
    ),
  );

describe('AI chat tools (monolith)', () => {
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
  const notify = (who: Tokens, title: string) =>
    e2e.notifications.insert({
      id: generateId(),
      tenantId: who.tenantId,
      userId: who.user.id,
      type: 'system',
      title,
      body: `${title} body`,
      data: {},
      read: false,
      createdAt: new Date(),
    });

  beforeAll(async () => {
    e2e = await createMonolithE2eApp({
      aiModel: mockScriptedModel([
        {
          toolCalls: [
            { toolName: 'get_my_profile', input: {} },
            { toolName: 'list_my_notifications', input: {} },
            { toolName: 'list_my_payments', input: {} },
          ],
        },
        (call) => ({ text: toolResultsOf(call) }),
      ]),
    });
    ada = await register('ada.tools@example.com');
    bob = await register('bob.tools@example.com');
    await notify(ada, 'Ada invoice ready');
    await notify(bob, 'Bob secret notice');
  });
  afterAll(async () => {
    await e2e?.app.close();
  });

  it('runs every tool as the caller and stores the calls and results', async () => {
    expect(ada.tenantId).not.toBe(bob.tenantId);
    const created = await inject({
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: bearer(ada.accessToken),
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);
    const conversationId = created.json<{ id: string }>().id;

    const sent = await inject({
      method: 'POST',
      url: `/v1/ai/conversations/${conversationId}/messages`,
      headers: bearer(ada.accessToken),
      payload: { content: 'What do you know about me?' },
    });

    expect(sent.statusCode, sent.body).toBe(201);
    const reply = sent.json<{ message: { content: string } }>().message.content;
    const results = JSON.parse(reply) as {
      tool: string;
      output: { type: string; value: unknown };
    }[];
    expect(results.map((r) => [r.tool, r.output.type])).toEqual([
      ['get_my_profile', 'json'],
      ['list_my_notifications', 'json'],
      ['list_my_payments', 'json'],
    ]);
    expect(results[0]?.output.value).toMatchObject({
      id: ada.user.id,
      email: 'ada.tools@example.com',
      roles: ['owner'],
    });
    expect(results[1]?.output.value).toMatchObject({
      items: [expect.objectContaining({ title: 'Ada invoice ready' })],
    });
    expect(results[2]?.output.value).toEqual({ items: [], hasMore: false });
    expect(reply).not.toContain('bob');
    expect(reply).not.toContain('Bob secret notice');

    const messages = await inject({
      method: 'GET',
      url: `/v1/ai/conversations/${conversationId}/messages`,
      headers: bearer(ada.accessToken),
    });
    expect(messages.statusCode, messages.body).toBe(200);
    expect(messages.json<{ items: { role: string }[] }>().items.map((m) => m.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
  });
});
