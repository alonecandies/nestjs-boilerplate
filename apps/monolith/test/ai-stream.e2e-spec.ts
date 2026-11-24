/*
 * AI streaming in the monolith (AI plan Task 4): `POST /v1/ai/conversations/:id/messages/stream`
 * (Server-Sent Events `delta`, `done`, `error`) over a REAL HTTP connection, cancellation when the
 * client disconnects, the GraphQL mirror of the REST API, and the `aiMessageStream` subscription
 * over graphql-ws, delivered only to its owner. The model is a mock streaming chunks; nothing
 * reaches OpenRouter. The ai repositories are the in-memory twins.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    AI_ENABLED: 'true',
    OPENROUTER_API_KEY: 'sk-or-v1-e2e-key-never-sent',
    AI_DEFAULT_MODEL: 'mock/default',
    AI_ALLOWED_MODELS: 'mock/other',
    AI_CHAT_LIMIT: '3',
    AI_CHAT_TENANT_LIMIT: '100',
    // C11's WebSocket caps stay out of the way.
    THROTTLE_WS_HANDSHAKE_LIMIT: '100000',
    THROTTLE_WS_SOCKETS_PER_USER: '1000',
  });
});

import type { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { AiPort, aiMessageStreamTrigger } from '@domain/ai/api';
import {
  mockFailingModel,
  mockHangingModel,
  mockStreamModel,
  mockTextModel,
} from '@platform/ai/testing';
import { signTestAccessToken } from '@platform/auth/testing';
import { generateId, PROBLEM_JSON_CONTENT_TYPE } from '@platform/common';
import { GRAPHQL_PUB_SUB } from '@platform/graphql';
import {
  GraphqlWsClients,
  type GraphqlWsCollector,
  listenOnLoopback,
  waitUntil,
} from '@platform/testing/realtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, expectProblem, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

type MockModel = ReturnType<typeof mockTextModel>;
interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string };
}
interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}
interface SseResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** Parsed events so far (grows while the stream is open). */
  events: SseEvent[];
  /** The raw body so far. */
  body: string;
  /** Resolves when the server ended the response (or the client closed it). */
  ended: Promise<void>;
  /** Drops the connection, as a browser tab that closes. */
  close(): void;
}
interface StreamEvent {
  aiMessageStream: {
    conversationId: string;
    type: string;
    delta: string | null;
    replayed: boolean | null;
    message: { id: string; text: string | null; status: string } | null;
  };
}

const SUBSCRIBE = `subscription Stream($id: UUID!) {
  aiMessageStream(conversationId: $id) {
    conversationId type delta replayed message { id text status }
  }
}`;
const STREAM_MUTATION = `mutation Stream($input: SendAiMessageInput!) {
  streamAiMessage(input: $input) { replayed message { id role text status model } }
}`;

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

/** Passes `events` through and calls `onEnd` once the consumer has read them to their end. */
async function* untilEnd<T>(events: AsyncIterable<T>, onEnd: () => void): AsyncGenerator<T> {
  try {
    yield* events;
  } finally {
    onEnd();
  }
}

/** A marker push as a subscriber receives it (see `pushMarker`). */
const markerEvent = (conversationId: string, delta: string) => ({
  conversationId,
  type: 'DELTA',
  delta,
  replayed: null,
  message: null,
});

describe('AI streaming (monolith)', () => {
  let e2e: MonolithE2e;
  let httpUrl = '';
  let wsUrl = '';
  let model: MockModel = mockTextModel('unused');
  const clients = new GraphqlWsClients();
  let ada: Tokens;
  let bob: Tokens;
  /**
   * The conversations whose streamed turn the server has read to its end. A cut turn stores its
   * reply and usage row before its stream settles, so a spec awaits this, not a pause.
   */
  const endedTurns: string[] = [];
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
  const createConversation = async (who: Tokens): Promise<string> => {
    const res = await inject({
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: bearer(who.accessToken),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  /** A signed token of `userId` acting in `tenantId` as a member. */
  const tokenFor = async (userId: string, tenantId: string): Promise<string> =>
    (
      await signTestAccessToken({
        id: userId,
        email: `${userId}@example.com`,
        tenantId,
        roles: ['member'],
      })
    ).token;

  /** Opens `POST …/messages/stream` over a real connection; resolves once the headers arrived. */
  const openStream = (
    token: string,
    conversationId: string,
    payload: object,
    headers: Record<string, string> = {},
  ): Promise<SseResponse> =>
    new Promise((resolve, reject) => {
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
            ...headers,
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

  const pubSub = () =>
    e2e.app.get<unknown>(GRAPHQL_PUB_SUB) as {
      ee: EventEmitter;
      publish(trigger: string, payload: unknown): Promise<void>;
    };
  const listeners = (trigger: string): number => pubSub().ee.listenerCount(trigger);
  /** A legitimate push of `delta` on the trigger of (tenant, user): it passes the filter. */
  const pushMarker = (
    tenantId: string,
    userId: string,
    conversationId: string,
    delta: string,
  ): Promise<void> =>
    pubSub().publish(aiMessageStreamTrigger(tenantId, userId, conversationId), {
      tenantId,
      userId,
      conversationId,
      type: 'delta',
      delta,
    });
  /** Subscribes as `token` and, when `trigger` is given, waits until the server listens on it. */
  const subscribe = async (
    token: string,
    conversationId: string,
    trigger?: string,
  ): Promise<GraphqlWsCollector<StreamEvent>> => {
    const connection = await clients.connect(wsUrl, {
      connectionParams: { authorization: `Bearer ${token}` },
    });
    const before = trigger === undefined ? 0 : listeners(trigger);
    const collector = connection.subscribe<StreamEvent>({
      query: SUBSCRIBE,
      variables: { id: conversationId },
    });
    if (trigger !== undefined) await waitUntil(() => listeners(trigger) > before);
    return collector;
  };
  const gql = (token: string, query: string, variables?: Record<string, unknown>) =>
    inject(graphql(query, variables, bearer(token)));

  beforeAll(async () => {
    e2e = await createMonolithE2eApp({ aiModel: () => model });
    ({ httpUrl, wsUrl } = await listenOnLoopback(e2e.app));
    ada = await register('ada.stream@example.com');
    bob = await register('bob.stream@example.com');
  });
  beforeEach(async () => {
    await e2e.redis.flushall();
    // Per test: `restoreMocks` restores every spy before each one.
    const port = e2e.app.get(AiPort, { strict: false });
    const streamMessage = port.streamMessage.bind(port);
    vi.spyOn(port, 'streamMessage').mockImplementation(async (input) =>
      untilEnd(await streamMessage(input), () => endedTurns.push(input.conversationId)),
    );
  });
  afterAll(async () => {
    await clients.disposeAll();
    await e2e?.app.close();
  });

  describe('SSE', () => {
    it('streams the deltas in order, then done with the stored reply and usage', async () => {
      model = mockStreamModel(['Hel', 'lo', ' there'], {
        usage: { inputTokens: 9, outputTokens: 3 },
      });
      const conversationId = await createConversation(ada);

      const stream = await openStream(ada.accessToken, conversationId, { content: 'Hi' });
      await stream.ended;

      expect(stream.status, stream.body).toBe(200);
      expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      expect(stream.headers['cache-control']).toBe('no-cache, no-transform');
      expect(String(stream.headers['ratelimit-policy'])).toContain('"route:ai.chat"');
      expect(stream.events.map((e) => e.event)).toEqual(['delta', 'delta', 'delta', 'done']);
      expect(stream.events.slice(0, 3).map((e) => e.data)).toEqual([
        { text: 'Hel' },
        { text: 'lo' },
        { text: ' there' },
      ]);
      const done = stream.events[3]?.data;
      expect(done).toEqual({
        replayed: false,
        usage: { inputTokens: 9, outputTokens: 3, costUsd: null },
        message: expect.objectContaining({
          role: 'assistant',
          content: 'Hello there',
          status: 'complete',
          model: 'mock/default',
          conversationId,
        }),
      });
      const stored = e2e.ai.persistence.store.messages.filter(
        (m) => m.conversationId === conversationId,
      );
      expect(stored.map((m) => [m.role, m.content, m.status]).sort()).toEqual([
        ['assistant', 'Hello there', 'complete'],
        ['user', 'Hi', 'complete'],
      ]);
    });

    it('a client that disconnects mid-stream aborts the model call; the partial reply is stored as incomplete', async () => {
      const hanging = mockHangingModel(['partial ']);
      model = hanging;
      const conversationId = await createConversation(ada);

      const stream = await openStream(ada.accessToken, conversationId, { content: 'Go on' });
      await waitUntil(() => stream.events.length > 0);
      expect(stream.events).toEqual([{ event: 'delta', data: { text: 'partial ' } }]);
      stream.close();

      await expect(hanging.aborted).resolves.toBeUndefined();
      const assistant = () =>
        e2e.ai.persistence.store.messages.filter(
          (m) => m.conversationId === conversationId && m.role === 'assistant',
        );
      // The server read the cut turn to its end: everything it stores is stored by then.
      await waitUntil(() => endedTurns.includes(conversationId));
      expect(assistant().map((m) => [m.content, m.status])).toEqual([['partial ', 'incomplete']]);
      expect(
        e2e.ai.persistence.store.usage
          .filter((u) => u.conversationId === conversationId)
          .map((u) => [u.outcome, u.messageId]),
      ).toEqual([['aborted', assistant()[0]?.id]]);
    });

    it('a failure after the headers is an `error` event with the problem document', async () => {
      // Any non-domain failure of the provider is a 502 AI_UPSTREAM_ERROR to the client.
      model = mockFailingModel(new Error('upstream exploded'));
      const conversationId = await createConversation(ada);

      const stream = await openStream(ada.accessToken, conversationId, { content: 'Hi' });
      await stream.ended;

      expect(stream.status).toBe(200);
      expect(stream.events).toEqual([
        {
          event: 'error',
          data: expect.objectContaining({ status: 502, code: 'AI_UPSTREAM_ERROR' }),
        },
      ]);
    });

    it('refusals before the stream are problem+json, and the policy is charged before the call', async () => {
      const streaming = mockStreamModel(['ok']);
      model = streaming;
      const missing = await openStream(ada.accessToken, generateId(), { content: 'Hi' });
      await missing.ended;
      expect(missing.status).toBe(404);
      expect(missing.headers['content-type']).toBe(PROBLEM_JSON_CONTENT_TYPE);
      expect(JSON.parse(missing.body)).toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });

      // AI_CHAT_LIMIT=3: the 404 above spent one; two more streams, then 429 without a call.
      const conversationId = await createConversation(ada);
      for (let i = 0; i < 2; i += 1) {
        const ok = await openStream(ada.accessToken, conversationId, { content: `turn ${i}` });
        await ok.ended;
        expect(ok.status, ok.body).toBe(200);
      }
      const limited = await inject({
        method: 'POST',
        url: `/v1/ai/conversations/${conversationId}/messages/stream`,
        headers: bearer(ada.accessToken),
        payload: { content: 'one more' },
      });
      expectProblem(limited, 429, 'RATE_LIMITED');
      expect(streaming.doStreamCalls).toHaveLength(2);
    });
  });

  describe('GraphQL', () => {
    it('mirrors the REST API: create, list, read, send, messages, delete', async () => {
      model = mockTextModel('Answer from the model.');
      const created = await gql(
        ada.accessToken,
        'mutation { createAiConversation(input: { title: "Via GraphQL" }) { id title model } }',
      );
      expect(created.json<{ errors?: unknown }>().errors, created.body).toBeUndefined();
      const conversation = created.json<{
        data: { createAiConversation: { id: string; title: string; model: string } };
      }>().data.createAiConversation;
      expect(conversation).toMatchObject({ title: 'Via GraphQL', model: 'mock/default' });

      const listed = await gql(ada.accessToken, '{ aiConversations(limit: 50) { items { id } } }');
      expect(
        listed
          .json<{ data: { aiConversations: { items: { id: string }[] } } }>()
          .data.aiConversations.items.map((c) => c.id),
      ).toContain(conversation.id);

      const sent = await gql(
        ada.accessToken,
        `mutation Send($input: SendAiMessageInput!) {
          sendAiMessage(input: $input) { replayed message { role text status } }
        }`,
        { input: { conversationId: conversation.id, content: 'Hi', idempotencyKey: 'gql-0001' } },
      );
      expect(sent.json()).toEqual({
        data: {
          sendAiMessage: {
            replayed: false,
            message: { role: 'ASSISTANT', text: 'Answer from the model.', status: 'COMPLETE' },
          },
        },
      });

      const messages = await gql(
        ada.accessToken,
        'query M($id: UUID!) { aiMessages(conversationId: $id) { items { role text } nextCursor } }',
        { id: conversation.id },
      );
      expect(messages.json()).toEqual({
        data: {
          aiMessages: {
            items: [
              { role: 'ASSISTANT', text: 'Answer from the model.' },
              { role: 'USER', text: 'Hi' },
            ],
            nextCursor: null,
          },
        },
      });

      const bobReads = await gql(
        bob.accessToken,
        'query C($id: UUID!) { aiConversation(id: $id) { id } }',
        { id: conversation.id },
      );
      expect(
        bobReads.json<{ errors: { extensions: { code: string } }[] }>().errors[0]?.extensions.code,
      ).toBe('CONVERSATION_NOT_FOUND');

      const deleted = await gql(
        ada.accessToken,
        'mutation D($id: UUID!) { deleteAiConversation(id: $id) }',
        { id: conversation.id },
      );
      expect(deleted.json()).toEqual({ data: { deleteAiConversation: true } });
    });

    it('streamAiMessage publishes the turn to aiMessageStream of its owner only (not another user or tenant)', async () => {
      model = mockStreamModel(['Stre', 'amed']);
      const conversationId = await createConversation(ada);
      const adaToken = ada.accessToken;
      const carolId = generateId();
      // Each subscriber listens on the trigger of its token's (tenant, user).
      const subscribers = [
        { token: adaToken, tenantId: ada.tenantId, userId: ada.user.id },
        // another member of A
        { token: await tokenFor(carolId, ada.tenantId), tenantId: ada.tenantId, userId: carolId },
        // Ada acting in another tenant
        {
          token: await tokenFor(ada.user.id, bob.tenantId),
          tenantId: bob.tenantId,
          userId: ada.user.id,
        },
        { token: bob.accessToken, tenantId: bob.tenantId, userId: bob.user.id },
      ];
      const collectors: GraphqlWsCollector<StreamEvent>[] = [];
      for (const { token, tenantId, userId } of subscribers) {
        collectors.push(
          await subscribe(
            token,
            conversationId,
            aiMessageStreamTrigger(tenantId, userId, conversationId),
          ),
        );
      }
      const pushToAll = async (delta: string): Promise<void> => {
        for (const { tenantId, userId } of subscribers) {
          await pushMarker(tenantId, userId, conversationId, delta);
        }
      };
      const last = (collector: GraphqlWsCollector<StreamEvent>) =>
        collector.received.at(-1)?.aiMessageStream.delta;
      // Every subscription delivers end to end before the turn runs: each receives a sentinel.
      await pushToAll('sentinel');
      await waitUntil(() => collectors.every((collector) => last(collector) === 'sentinel'));

      const res = await gql(adaToken, STREAM_MUTATION, {
        input: { conversationId, content: 'Stream it' },
      });
      expect(res.json<{ errors?: unknown }>().errors, res.body).toBeUndefined();
      const reply = res.json<{
        data: { streamAiMessage: { replayed: boolean; message: { id: string; text: string } } };
      }>().data.streamAiMessage;
      expect(reply).toMatchObject({ replayed: false, message: { text: 'Streamed' } });

      // A fence on every trigger after the turn: a subscription delivers in order, so once the
      // fence is in, any extra frame of the turn, or one that leaked to another trigger, is too.
      await pushToAll('fence');
      await waitUntil(() => collectors.every((collector) => last(collector) === 'fence'));
      const [own, ...others] = collectors as [
        GraphqlWsCollector<StreamEvent>,
        ...GraphqlWsCollector<StreamEvent>[],
      ];
      expect(own.received.map((r) => r.aiMessageStream)).toEqual([
        markerEvent(conversationId, 'sentinel'),
        { conversationId, type: 'DELTA', delta: 'Stre', replayed: null, message: null },
        { conversationId, type: 'DELTA', delta: 'amed', replayed: null, message: null },
        {
          conversationId,
          type: 'DONE',
          delta: null,
          replayed: false,
          message: { id: reply.message.id, text: 'Streamed', status: 'COMPLETE' },
        },
        markerEvent(conversationId, 'fence'),
      ]);
      expect(own.errors).toEqual([]);
      for (const other of others) {
        expect(other.received.map((r) => r.aiMessageStream)).toEqual([
          markerEvent(conversationId, 'sentinel'),
          markerEvent(conversationId, 'fence'),
        ]);
        expect(other.errors).toEqual([]);
      }
    });

    it('closing the graphql-ws socket aborts a streamAiMessage turn; the partial reply is stored as incomplete', async () => {
      const hanging = mockHangingModel(['partial ']);
      model = hanging;
      let aborted = false;
      void hanging.aborted.then(() => {
        aborted = true;
      });
      const conversationId = await createConversation(ada);
      const trigger = aiMessageStreamTrigger(ada.tenantId, ada.user.id, conversationId);
      const connection = await clients.connect(wsUrl, {
        connectionParams: { authorization: `Bearer ${ada.accessToken}` },
      });
      const before = listeners(trigger);
      const own = connection.subscribe<StreamEvent>({
        query: SUBSCRIBE,
        variables: { id: conversationId },
      });
      await waitUntil(() => listeners(trigger) > before);

      // The mutation runs over the same socket; it never resolves while the model hangs.
      connection.subscribe({
        query: STREAM_MUTATION,
        variables: { input: { conversationId, content: 'Go on' } },
      });
      await waitUntil(() => own.received.length > 0);
      expect(own.received.map((r) => r.aiMessageStream.delta)).toEqual(['partial ']);
      await connection.dispose();

      // Well before AI_REQUEST_TIMEOUT_MS (60 s): the close aborted the model call.
      await waitUntil(() => aborted);
      const assistant = () =>
        e2e.ai.persistence.store.messages.filter(
          (m) => m.conversationId === conversationId && m.role === 'assistant',
        );
      // The server read the cut turn to its end: everything it stores is stored by then.
      await waitUntil(() => endedTurns.includes(conversationId));
      expect(assistant().map((m) => [m.content, m.status])).toEqual([['partial ', 'incomplete']]);
      expect(
        e2e.ai.persistence.store.usage
          .filter((u) => u.conversationId === conversationId)
          .map((u) => [u.outcome, u.messageId]),
      ).toEqual([['aborted', assistant()[0]?.id]]);
    });

    it('yields nothing for a payload of another tenant published straight onto the owner’s trigger', async () => {
      const conversationId = await createConversation(ada);
      const trigger = aiMessageStreamTrigger(ada.tenantId, ada.user.id, conversationId);
      const own = await subscribe(ada.accessToken, conversationId, trigger);

      await pubSub().publish(trigger, {
        tenantId: bob.tenantId,
        userId: ada.user.id,
        conversationId,
        type: 'delta',
        delta: 'leak',
      });
      // The legitimate push right behind it proves the foreign one was filtered, not just slow.
      await pushMarker(ada.tenantId, ada.user.id, conversationId, 'fence');
      await waitUntil(() => own.received.length > 0);

      expect(own.received.map((r) => r.aiMessageStream)).toEqual([
        markerEvent(conversationId, 'fence'),
      ]);
    });
  });
});
