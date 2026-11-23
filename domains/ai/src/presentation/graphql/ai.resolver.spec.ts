import { getEventListeners } from 'node:events';
import { AiClient, AiMetrics } from '@platform/ai';
import {
  aiTestConfig,
  MockAiModelProvider,
  type MockModelTurn,
  mockScriptedModel,
} from '@platform/ai/testing';
import type { AuthUser } from '@platform/auth';
import { createPrincipal, PrincipalPermissions, runWithPrincipal } from '@platform/common';
import {
  createGraphqlWsConnectionSignals,
  type GqlContext,
  type GqlWsConnectionContext,
  type GraphqlPubSub,
  GraphqlWsConnectionClosedError,
} from '@platform/graphql';
import type { LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTestTransactionHost } from '../../../test/ai-test.utils.js';
import { StreamMessageCommand } from '../../application/commands/stream-message/stream-message.command.js';
import { StreamMessageHandler } from '../../application/commands/stream-message/stream-message.handler.js';
import type { AiPort } from '../../application/ports/ai.port.js';
import { AiChatTools } from '../../application/tools/ai-chat-tools.js';
import { AiToolName } from '../../application/tools/ai-tools.js';
import type { Conversation } from '../../domain/ai.types.js';
import { makeConversation } from '../../testing/ai-fixtures.js';
import { FakeAiToolSources } from '../../testing/fake-ai-tool-sources.js';
import {
  createInMemoryAiPersistence,
  type InMemoryAiPersistence,
} from '../../testing/in-memory-ai.js';
import { AiResolver } from './ai.resolver.js';
import type { AiMessageStreamPush } from './ai-message-stream.js';

const TENANT = '0198f0a0-0000-7000-8000-000000000001';
const ADA = { tenantId: TENANT, userId: '0198f0a0-0000-7000-8000-0000000000a1' };
const USER: AuthUser = {
  id: ADA.userId,
  email: 'ada@example.com',
  tenantId: TENANT,
  roles: ['member'],
  staff: false,
  permissions: ['ai:chat'],
  jti: '0198f0a0-0000-7000-8000-0000000000f1',
  exp: 4_102_444_800,
};
const metrics = new AiMetrics();
const PROFILE = { toolName: AiToolName.GetMyProfile, input: {} };

/** RBAC stand-in: every principal holds `granted`. */
class FixedPermissions extends PrincipalPermissions {
  constructor(private readonly granted: readonly string[]) {
    super();
  }
  override of(): readonly string[] {
    return this.granted;
  }
}

/** A graphql-ws socket: its connection context and the signals the Apollo config keeps. */
function openSocket() {
  const signals = createGraphqlWsConnectionSignals();
  const ctx: GqlWsConnectionContext = { extra: {} };
  signals.open(ctx);
  const signal = signals.signalOf(ctx);
  if (signal === undefined) throw new Error('the socket has no connection signal');
  /** The context of one operation on the socket (the request part is unused here). */
  const context = (): GqlContext => ({
    req: { id: 'ws-op', headers: {} },
    connectionSignal: signal,
    loaders: {},
  });
  return { signal, context, close: () => signals.close(ctx) };
}

describe('AiResolver.streamAiMessage over graphql-ws', () => {
  let db: InMemoryAiPersistence;
  let pushes: AiMessageStreamPush[];
  /** Runs on each publish, before the event is recorded. */
  let onPublish: (() => void) | undefined;

  /** The real resolver over the real stream handler; each model id gets its own model. */
  function setup(models: Record<string, LanguageModel>) {
    const config = aiTestConfig();
    const provider = new MockAiModelProvider((id) => {
      const model = models[id];
      if (model === undefined) throw new Error(`no mock model for ${id}`);
      return model;
    });
    const sources = new FakeAiToolSources();
    sources.addUser(ADA, { email: USER.email, displayName: 'ada' });
    const tools = new AiChatTools(new FixedPermissions(['notifications:read']), sources);
    const handler = new StreamMessageHandler(
      db.conversations,
      db.messages,
      db.usage,
      new AiClient(config, provider, metrics),
      config,
      tools,
    );
    const port = {
      streamMessage: (input) => handler.execute(new StreamMessageCommand(input)),
    } as Partial<AiPort> as AiPort;
    const pubSub = {
      publish: async (_trigger: string, payload: AiMessageStreamPush) => {
        onPublish?.();
        pushes.push(payload);
      },
    } as Partial<GraphqlPubSub> as GraphqlPubSub;
    const resolver = new AiResolver(port, pubSub);
    /** One `streamAiMessage` operation in `conversation`, as Ada (the request's CLS context). */
    const stream = (conversation: Conversation, context: GqlContext) =>
      runWithPrincipal(createPrincipal({ ...ADA, roles: ['member'] }), () =>
        resolver.streamAiMessage(
          { conversationId: conversation.id, content: 'Who am I?' },
          USER,
          context,
        ),
      );
    return { stream };
  }

  async function newConversation(model: string): Promise<Conversation> {
    const conversation = makeConversation(ADA, { model });
    await runWithPrincipal(createPrincipal({ ...ADA, roles: ['member'] }), () =>
      db.conversations.create(conversation),
    );
    return conversation;
  }

  const deltasOf = (conversation: Conversation) =>
    pushes.filter((p) => p.conversationId === conversation.id && p.type === 'delta');

  beforeEach(() => {
    db = createInMemoryAiPersistence();
    installTestTransactionHost(db.store);
    pushes = [];
    onPublish = undefined;
  });

  it('one socket close cutting two turns: each usage row holds its own billed usage', async () => {
    /** A billed tool step (`billed`), then a step that answers "Still looking. " and hangs. */
    const toolThenHang = (billed: MockModelTurn) =>
      mockScriptedModel([
        { toolCalls: [PROFILE], ...billed },
        { text: 'Still looking. ', hang: true },
      ]);
    const { stream } = setup({
      'mock/default': toolThenHang({ usage: { inputTokens: 1_000, outputTokens: 50 }, costUsd: 1 }),
      'mock/other': toolThenHang({ usage: { inputTokens: 2_000, outputTokens: 70 }, costUsd: 2 }),
    });
    const first = await newConversation('mock/default');
    const second = await newConversation('mock/other');
    const socket = openSocket();

    const turns = [first, second].map((conversation) =>
      stream(conversation, socket.context()).catch((error: unknown) => error),
    );
    // Both tool steps were billed: each turn is in its hanging answer.
    await vi.waitFor(() => {
      expect(deltasOf(first)).toHaveLength(1);
      expect(deltasOf(second)).toHaveLength(1);
    });
    socket.close();
    const errors = await Promise.all(turns);

    const rowOf = (conversation: Conversation) =>
      db.store.usage.filter((row) => row.conversationId === conversation.id);
    expect(rowOf(first)).toEqual([
      expect.objectContaining({ outcome: 'aborted', inputTokens: 1_000, outputTokens: 50 }),
    ]);
    expect(rowOf(first)[0]?.costUsd).toBeCloseTo(1, 10);
    expect(rowOf(second)).toEqual([
      expect.objectContaining({ outcome: 'aborted', inputTokens: 2_000, outputTokens: 70 }),
    ]);
    expect(rowOf(second)[0]?.costUsd).toBeCloseTo(2, 10);
    // Each operation is aborted with its own reason, not the socket's shared one.
    for (const error of errors) {
      expect(error).toBeInstanceOf(GraphqlWsConnectionClosedError);
      expect(error).not.toBe(socket.signal.reason);
    }
    expect(errors[0]).not.toBe(errors[1]);
    expect(pushes.filter((p) => p.type === 'error')).toEqual([
      expect.objectContaining({ conversationId: first.id, errorCode: 'CLIENT_DISCONNECTED' }),
      expect.objectContaining({ conversationId: second.id, errorCode: 'CLIENT_DISCONNECTED' }),
    ]);
  });

  it('a turn that ended leaves no listener on the connection signal', async () => {
    const { stream } = setup({
      'mock/default': mockScriptedModel([{ toolCalls: [PROFILE] }, { text: 'You are Ada.' }]),
    });
    const conversation = await newConversation('mock/default');
    const socket = openSocket();
    let listenersDuringTurn = 0;
    onPublish = () => {
      const listeners = getEventListeners(socket.signal, 'abort').length;
      listenersDuringTurn = Math.max(listenersDuringTurn, listeners);
    };

    const result = await stream(conversation, socket.context());

    expect(result.message.text).toBe('You are Ada.');
    expect(listenersDuringTurn).toBe(1); // the operation listened for the close while it ran
    expect(getEventListeners(socket.signal, 'abort')).toHaveLength(0);
    expect(socket.signal.aborted).toBe(false);
  });

  it('an operation on a socket already closed is aborted at once with its own reason', async () => {
    const { stream } = setup({ 'mock/default': mockScriptedModel([{ text: 'never sent' }]) });
    const conversation = await newConversation('mock/default');
    const socket = openSocket();
    socket.close();

    const error = await stream(conversation, socket.context()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphqlWsConnectionClosedError);
    expect(error).not.toBe(socket.signal.reason);
    expect(db.store.usage).toEqual([]); // nothing was sent: no usage row
    expect(getEventListeners(socket.signal, 'abort')).toHaveLength(0);
  });
});
