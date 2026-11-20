/*
 * The AI chat API in the microservices topology (AI plan Task 6): the gateway serves the SAME REST
 * and SSE routes as the monolith, bound to `AiApiModule.forRemote()`, whose real gRPC adapter calls
 * a stand-in ai-service on loopback: the real `AiGrpcController` (validation, the principal from the
 * metadata, error trailers, the streamed turn) over an in-memory `FakeAiPort`. So each case crosses
 * the real hop: JWT + `ai:chat` + `ai.chat` at the edge, the caller in metadata, domain codes back,
 * deltas in order, and the client's disconnect cancelling the call in ai-service.
 */
await vi.hoisted(async () => {
  const { createServer } = await import('node:net');
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No free port');
  // AiApiModule.forRemote() reads AI_GRPC_URL when AppModule's decorators evaluate.
  Object.assign(process.env, GATEWAY_E2E_ENV, {
    AI_GRPC_URL: `127.0.0.1:${address.port}`,
    AI_CHAT_LIMIT: '4',
    AI_CHAT_TENANT_LIMIT: '100',
  });
});

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { FakeAiPort, startFakeAiService } from '@domain/ai/testing';
import type { INestMicroservice } from '@nestjs/common';
import { signTestAccessToken } from '@platform/auth/testing';
import { ExternalServiceException, generateId, PROBLEM_JSON_CONTENT_TYPE } from '@platform/common';
import { listenOnLoopback, waitUntil } from '@platform/testing/realtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';
import { bearer, expectProblem } from './support/http.js';

interface Tokens {
  accessToken: string;
  user: { id: string };
}
interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}
interface SseResponse {
  status: number;
  headers: IncomingHttpHeaders;
  events: SseEvent[];
  body: string;
  ended: Promise<void>;
  close(): void;
}

const PASSWORD = 'a very long passphrase';

/** The `tid` (active tenant) claim of an access token: what the gateway forwards as `tenantId`. */
const tenantIdOf = (accessToken: string): string => {
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString());
  return (payload as { tid: string }).tid;
};

/** Parses `event:` / `data:` blocks separated by a blank line. */
function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !block.startsWith(':'))
    .flatMap((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (event === undefined || !block.endsWith('}')) return [];
      return [{ event, data: JSON.parse(data) as Record<string, unknown> }];
    });
}

describe('AI chat through the gateway (forRemote → ai-service over gRPC)', () => {
  let e2e: GatewayE2e;
  let upstream: INestMicroservice;
  let httpUrl = '';
  let ada: Tokens;
  let bob: Tokens;
  const ai = new FakeAiPort();
  const inject = (...args: Parameters<GatewayE2e['app']['inject']>) => e2e.app.inject(...args);

  const register = async (email: string): Promise<Tokens> => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName: email },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Tokens>();
  };
  const createConversation = async (who: Tokens, payload: object = {}): Promise<string> => {
    const res = await inject({
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: bearer(who.accessToken),
      payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };

  /** Opens `POST …/messages/stream` over a real connection; resolves once the headers arrived. */
  const openStream = (token: string, conversationId: string, payload: object) =>
    new Promise<SseResponse>((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = httpRequest(
        `${httpUrl}/v1/ai/conversations/${conversationId}/messages/stream`,
        {
          method: 'POST',
          headers: {
            ...bearer(token),
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
            accept: 'text/event-stream',
          },
        },
        (res) => {
          res.setEncoding('utf8');
          let markEnded!: () => void;
          const response: SseResponse = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            events: [],
            body: '',
            ended: new Promise<void>((done) => {
              markEnded = done;
            }),
            close: () => req.destroy(),
          };
          res.on('data', (chunk: string) => {
            response.body += chunk;
            response.events = parseSse(response.body);
          });
          res.on('end', () => markEnded());
          res.on('close', () => markEnded());
          res.on('error', () => markEnded());
          resolve(response);
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  beforeAll(async () => {
    upstream = await startFakeAiService(process.env['AI_GRPC_URL'] ?? '', ai);
    e2e = await createGatewayE2eApp();
    ({ httpUrl } = await listenOnLoopback(e2e.app));
    ada = await register('ada.ai@example.com');
    bob = await register('bob.ai@example.com');
  });
  beforeEach(async () => {
    await e2e.redis.flushall();
    ai.disabled = false;
    ai.principals.length = 0;
    ai.stream = { deltas: ['Hel', 'lo'] };
  });
  afterAll(async () => {
    await e2e?.app.close();
    await upstream?.close();
  });

  describe('REST', () => {
    it("create, list, read, send, messages and delete run in ai-service as the token's caller", async () => {
      const id = await createConversation(ada, { title: 'Through the gateway' });
      expect(ai.principals.at(-1)).toMatchObject({
        userId: ada.user.id,
        tenantId: tenantIdOf(ada.accessToken),
      });

      const list = await inject({
        method: 'GET',
        url: '/v1/ai/conversations',
        headers: bearer(ada.accessToken),
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json<{ items: { id: string; title: string }[]; nextCursor: null }>()).toEqual({
        items: [expect.objectContaining({ id, title: 'Through the gateway' })],
        nextCursor: null,
      });

      const read = await inject({
        method: 'GET',
        url: `/v1/ai/conversations/${id}`,
        headers: bearer(ada.accessToken),
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toEqual({
        id,
        title: 'Through the gateway',
        model: 'mock/default',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });

      const sent = await inject({
        method: 'POST',
        url: `/v1/ai/conversations/${id}/messages`,
        headers: { ...bearer(ada.accessToken), 'idempotency-key': 'gateway-key-0001' },
        payload: { content: 'Hi' },
      });
      expect(sent.statusCode, sent.body).toBe(201);
      expect(sent.json()).toEqual({
        replayed: false,
        message: expect.objectContaining({
          role: 'assistant',
          content: 'Hello from the fake ai-service.',
          status: 'complete',
          conversationId: id,
          inputTokens: null,
        }),
      });

      const messages = await inject({
        method: 'GET',
        url: `/v1/ai/conversations/${id}/messages`,
        headers: bearer(ada.accessToken),
      });
      expect(messages.statusCode, messages.body).toBe(200);
      expect(messages.json<{ items: { role: string }[] }>().items.map((m) => m.role)).toEqual([
        'assistant',
        'user',
      ]);

      const deleted = await inject({
        method: 'DELETE',
        url: `/v1/ai/conversations/${id}`,
        headers: bearer(ada.accessToken),
      });
      expect(deleted.statusCode, deleted.body).toBe(204);
      expect(ai.conversations.has(id)).toBe(false);
    });

    it("another user's conversation is 404 CONVERSATION_NOT_FOUND (the code crossed the hop)", async () => {
      const id = await createConversation(ada);
      const res = await inject({
        method: 'GET',
        url: `/v1/ai/conversations/${id}`,
        headers: bearer(bob.accessToken),
      });
      expectProblem(res, 404, 'CONVERSATION_NOT_FOUND');
    });

    it('AI disabled in ai-service is 503 AI_DISABLED at the edge', async () => {
      ai.disabled = true;
      const res = await inject({
        method: 'POST',
        url: '/v1/ai/conversations',
        headers: bearer(ada.accessToken),
        payload: {},
      });
      expectProblem(res, 503, 'AI_DISABLED');
    });

    it('a token without ai:chat is 403 at the edge; ai-service is never called', async () => {
      const { token } = await signTestAccessToken({
        id: generateId(),
        email: 'nobody@example.com',
        tenantId: tenantIdOf(ada.accessToken),
        roles: [],
      });
      const res = await inject({
        method: 'GET',
        url: '/v1/ai/conversations',
        headers: bearer(token),
      });
      expectProblem(res, 403);
      expect(ai.principals).toEqual([]);
    });
  });

  describe('SSE', () => {
    it('streams the deltas in order, then done with the stored reply and usage', async () => {
      ai.stream = { deltas: ['Hel', 'lo', ' there'] };
      const id = await createConversation(ada);

      const stream = await openStream(ada.accessToken, id, { content: 'Hi' });
      await stream.ended;

      expect(stream.status, stream.body).toBe(200);
      expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      expect(String(stream.headers['ratelimit-policy'])).toContain('"route:ai.chat"');
      expect(stream.events.map((e) => e.event)).toEqual(['delta', 'delta', 'delta', 'done']);
      expect(stream.events.slice(0, 3).map((e) => e.data)).toEqual([
        { text: 'Hel' },
        { text: 'lo' },
        { text: ' there' },
      ]);
      expect(stream.events[3]?.data).toEqual({
        replayed: false,
        usage: { inputTokens: 7, outputTokens: 3, costUsd: null },
        message: expect.objectContaining({
          role: 'assistant',
          content: 'Hello there',
          status: 'complete',
          conversationId: id,
        }),
      });
    });

    it('a client that disconnects mid-stream cancels the call; ai-service sees the abort', async () => {
      ai.stream = { deltas: ['partial '], end: 'hang' };
      const id = await createConversation(ada);
      const before = ai.streamSignals.length;

      const stream = await openStream(ada.accessToken, id, { content: 'Go on' });
      await waitUntil(() => stream.events.length > 0);
      expect(stream.events).toEqual([{ event: 'delta', data: { text: 'partial ' } }]);
      stream.close();

      const signal = ai.streamSignals[before];
      if (signal === undefined) throw new Error('ai-service never started the turn');
      await waitUntil(() => signal.aborted);
      await waitUntil(() =>
        ai.messages.some((m) => m.conversationId === id && m.status === 'incomplete'),
      );
    });

    it('a refusal before the stream is plain problem+json (404 from ai-service)', async () => {
      const missing = await openStream(ada.accessToken, generateId(), { content: 'Hi' });
      await missing.ended;
      expect(missing.status).toBe(404);
      expect(missing.headers['content-type']).toBe(PROBLEM_JSON_CONTENT_TYPE);
      expect(JSON.parse(missing.body)).toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    });

    it('a failure after the headers is an `error` event with the code from ai-service', async () => {
      // What @platform/ai's AiUpstreamError is: a 502 with its code.
      ai.stream = {
        deltas: ['Hel'],
        end: new ExternalServiceException('The AI model failed to answer', {
          code: 'AI_UPSTREAM_ERROR',
        }),
      };
      const id = await createConversation(ada);

      const stream = await openStream(ada.accessToken, id, { content: 'Hi' });
      await stream.ended;

      expect(stream.status).toBe(200);
      expect(stream.events).toEqual([
        { event: 'delta', data: { text: 'Hel' } },
        {
          event: 'error',
          data: expect.objectContaining({ status: 502, code: 'AI_UPSTREAM_ERROR' }),
        },
      ]);
    });
  });
});
