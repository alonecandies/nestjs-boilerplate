/*
 * The SSE `error` event and the REST problem of one app share the same problem `type` base URL
 * (review minors, AI-3). The real module graph boots with `problemTypeBaseUrl` set: the AI
 * controller sits in a feature module, where a plain `@Optional() @Inject(...)` of the options
 * resolves to `undefined`, so only booting the whole graph proves that DI delivers them. The model
 * is a mock; nothing reaches OpenRouter.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    AI_ENABLED: 'true',
    OPENROUTER_API_KEY: 'sk-or-v1-e2e-key-never-sent',
    AI_DEFAULT_MODEL: 'mock/default',
    AI_ALLOWED_MODELS: 'mock/other',
  });
});

import { mockFailingModel } from '@platform/ai/testing';
import { generateId } from '@platform/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, expectProblem } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

const BASE_URL = 'https://errors.example.test/';

describe('problem type base URL (monolith, AI)', () => {
  let e2e: MonolithE2e;
  let accessToken = '';

  beforeAll(async () => {
    e2e = await createMonolithE2eApp({
      aiModel: () => mockFailingModel(new Error('upstream exploded')),
      problemTypeBaseUrl: BASE_URL,
    });
    const registered = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'ada.problem-type@example.com',
        password: 'correct horse battery staple',
        displayName: 'Ada',
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    accessToken = registered.json<{ accessToken: string }>().accessToken;
  });
  afterAll(async () => {
    await e2e?.app.close();
  });

  it('the SSE `error` event builds its `type` from the configured base URL', async () => {
    const created = await e2e.app.inject({
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: bearer(accessToken),
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);

    const res = await e2e.app.inject({
      method: 'POST',
      url: `/v1/ai/conversations/${created.json<{ id: string }>().id}/messages/stream`,
      headers: { ...bearer(accessToken), accept: 'text/event-stream' },
      payload: { content: 'Hi' },
    });

    expect(res.statusCode, res.body).toBe(200);
    const data = res.body.split('\n').find((line) => line.startsWith('data: '));
    expect(res.body).toContain('event: error');
    expect(JSON.parse(data?.slice(6) ?? '{}')).toMatchObject({
      status: 502,
      code: 'AI_UPSTREAM_ERROR',
      type: `${BASE_URL}ai-upstream-error`,
    });
  });

  it('a REST problem from the same app uses the same base URL', async () => {
    const res = await e2e.app.inject({
      method: 'GET',
      url: `/v1/ai/conversations/${generateId()}`,
      headers: bearer(accessToken),
    });

    const problem = expectProblem(res, 404, 'CONVERSATION_NOT_FOUND');
    expect(problem.type).toBe(`${BASE_URL}conversation-not-found`);
  });
});
