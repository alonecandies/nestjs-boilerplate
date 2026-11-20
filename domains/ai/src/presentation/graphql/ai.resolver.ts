import type { ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { ErrorCode, isDomainException, Timeout } from '@platform/common';
import { type GqlContext, GraphQLUUID, type GraphqlPubSub, InjectPubSub } from '@platform/graphql';
import { RateLimit } from '@platform/redis';
import { AiPermission } from '../../ai.permissions.js';
import { AiPort, type SendMessageResult } from '../../application/ports/ai.port.js';
import { abortOnDisconnect } from '../client-disconnect.js';
import { toMessageResponse } from '../http/ai.dto.js';
import { AI_RATE_LIMITS } from '../rate-limit/ai-rate-limit.js';
import {
  type AiMessageStreamPush,
  aiMessageStreamTrigger,
  isOwnStreamEvent,
  toAiMessageStreamEvent,
} from './ai-message-stream.js';
import { AiConversationsArgs, AiMessagesArgs } from './args/ai.args.js';
import { CreateAiConversationInput, SendAiMessageInput } from './inputs/ai.inputs.js';
import {
  AiConversationConnectionModel,
  AiConversationModel,
  toAiConversationConnection,
  toAiConversationModel,
} from './models/ai-conversation.model.js';
import {
  AiMessageConnectionModel,
  AiSendMessageResultModel,
  toAiMessageConnection,
  toAiSendMessageResult,
} from './models/ai-message.model.js';
import { AiMessageStreamEventModel } from './models/ai-message-stream-event.model.js';

/** The raw response of an HTTP operation (the Fastify reply's `raw`); none over graphql-ws. */
function rawResponseOf(reply: unknown): ServerResponse | undefined {
  if (typeof reply !== 'object' || reply === null || !('raw' in reply)) return undefined;
  return reply.raw as ServerResponse;
}

/**
 * The GraphQL mirror of `/v1/ai/conversations` plus streaming: queries `aiConversations`,
 * `aiConversation`, `aiMessages`; mutations `createAiConversation`, `deleteAiConversation`,
 * `sendAiMessage` (the reply at once) and `streamAiMessage` (the same turn, streamed: each chunk is
 * published to the `aiMessageStream(conversationId)` subscription of the caller, and the mutation
 * resolves with the stored reply). Tenant and user always come from the verified token; every
 * operation needs `ai:chat`, and both send mutations charge the `ai.chat` policy before the call.
 */
@Resolver()
@RequirePermissions(AiPermission.Chat)
export class AiResolver {
  private readonly logger = new Logger(AiResolver.name);

  constructor(
    private readonly ai: AiPort,
    @InjectPubSub() private readonly pubSub: GraphqlPubSub,
  ) {}

  @Query(() => AiConversationConnectionModel, {
    name: 'aiConversations',
    description: 'My AI conversations, newest first.',
    complexity: 5,
  })
  async aiConversations(
    @Args() args: AiConversationsArgs,
    @CurrentUser() user: AuthUser,
  ): Promise<AiConversationConnectionModel> {
    const page = await this.ai.listConversations({
      tenantId: user.tenantId,
      userId: user.id,
      limit: args.limit,
      cursor: args.cursor ?? undefined,
    });
    return toAiConversationConnection(page);
  }

  @Query(() => AiConversationModel, {
    name: 'aiConversation',
    description: 'One of my AI conversations. CONVERSATION_NOT_FOUND for anyone else’s.',
  })
  async aiConversation(
    @Args('id', { type: () => GraphQLUUID }) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AiConversationModel> {
    const conversation = await this.ai.getConversation({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: id,
    });
    return toAiConversationModel(conversation);
  }

  @Query(() => AiMessageConnectionModel, {
    name: 'aiMessages',
    description: 'The messages of one of my AI conversations, newest first.',
    complexity: 5,
  })
  async aiMessages(
    @Args() args: AiMessagesArgs,
    @CurrentUser() user: AuthUser,
  ): Promise<AiMessageConnectionModel> {
    const page = await this.ai.listMessages({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: args.conversationId,
      limit: args.limit,
      cursor: args.cursor ?? undefined,
    });
    return toAiMessageConnection(page);
  }

  @Mutation(() => AiConversationModel, {
    name: 'createAiConversation',
    description: 'Starts a conversation (AI_MODEL_NOT_ALLOWED, AI_DISABLED).',
  })
  async createAiConversation(
    @Args('input') input: CreateAiConversationInput,
    @CurrentUser() user: AuthUser,
  ): Promise<AiConversationModel> {
    const conversation = await this.ai.createConversation({
      tenantId: user.tenantId,
      userId: user.id,
      title: input.title ?? undefined,
      model: input.model ?? undefined,
    });
    return toAiConversationModel(conversation);
  }

  @Mutation(() => Boolean, {
    name: 'deleteAiConversation',
    description: 'Deletes one of my conversations and its messages (usage records stay).',
  })
  async deleteAiConversation(
    @Args('id', { type: () => GraphQLUUID }) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<boolean> {
    await this.ai.deleteConversation({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: id,
    });
    return true;
  }

  @Mutation(() => AiSendMessageResultModel, {
    name: 'sendAiMessage',
    description:
      'Sends a message and returns the reply (an `idempotencyKey` replay returns it again).',
  })
  @RateLimit(AI_RATE_LIMITS.CHAT)
  // Bounded by AI_REQUEST_TIMEOUT_MS (the model call's deadline), not the default handler timeout.
  @Timeout(0)
  async sendAiMessage(
    @Args('input') input: SendAiMessageInput,
    @CurrentUser() user: AuthUser,
  ): Promise<AiSendMessageResultModel> {
    const result = await this.ai.sendMessage({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: input.conversationId,
      content: input.content,
      model: input.model ?? undefined,
      idempotencyKey: input.idempotencyKey ?? undefined,
    });
    return toAiSendMessageResult(result);
  }

  @Mutation(() => AiSendMessageResultModel, {
    name: 'streamAiMessage',
    description:
      'sendAiMessage, streamed: subscribe to `aiMessageStream(conversationId)` first to receive ' +
      'each chunk (`DELTA`), then `DONE` or `ERROR`; the mutation resolves with the stored reply. ' +
      'Over HTTP, closing the request aborts the model call (the reply so far is stored INCOMPLETE).',
  })
  @RateLimit(AI_RATE_LIMITS.CHAT)
  @Timeout(0)
  async streamAiMessage(
    @Args('input') input: SendAiMessageInput,
    @CurrentUser() user: AuthUser,
    @Context() context: GqlContext,
  ): Promise<AiSendMessageResultModel> {
    const base = {
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: input.conversationId,
    };
    const trigger = aiMessageStreamTrigger(user.tenantId, user.id, input.conversationId);
    const disconnect = abortOnDisconnect(rawResponseOf(context.reply));
    try {
      const events = await this.ai.streamMessage({
        ...base,
        content: input.content,
        model: input.model ?? undefined,
        idempotencyKey: input.idempotencyKey ?? undefined,
        signal: disconnect.signal,
      });
      let result: SendMessageResult | undefined;
      try {
        for await (const event of events) {
          if (event.type === 'delta') {
            await this.publish(trigger, { ...base, type: 'delta', delta: event.text });
          } else {
            result = event;
            await this.publish(trigger, {
              ...base,
              type: 'done',
              message: toMessageResponse(event.message),
              replayed: event.replayed,
            });
          }
        }
      } catch (error) {
        const errorCode = disconnect.signal.aborted ? CLIENT_DISCONNECTED : errorCodeOf(error);
        await this.publish(trigger, { ...base, type: 'error', errorCode });
        throw error;
      }
      if (result === undefined) throw new Error('The chat stream ended without a reply');
      return toAiSendMessageResult(result);
    } finally {
      disconnect.dispose();
    }
  }

  @Subscription(() => AiMessageStreamEventModel, {
    name: 'aiMessageStream',
    description:
      'The chunks of my streamed turns (`streamAiMessage`) in this conversation, as they come.',
    filter: isOwnStreamEvent,
    resolve: toAiMessageStreamEvent,
  })
  aiMessageStream(
    @Args('conversationId', { type: () => GraphQLUUID }) conversationId: string,
    @CurrentUser() user: AuthUser,
  ): AsyncIterableIterator<AiMessageStreamPush> {
    // Tenant and user both from the verified token, fixed for the life of the subscription.
    return this.pubSub.asyncIterableIterator<AiMessageStreamPush>(
      aiMessageStreamTrigger(user.tenantId, user.id, conversationId),
    );
  }

  /** Best effort: a subscriber missing a chunk must not fail the turn the caller is waiting for. */
  private async publish(trigger: string, payload: AiMessageStreamPush): Promise<void> {
    try {
      await this.pubSub.publish(trigger, payload);
    } catch (error) {
      this.logger.warn(
        `Could not publish an aiMessageStream event: ${error instanceof Error ? error.name : typeof error}`,
      );
    }
  }
}

/** `errorCode` of the `ERROR` event of a turn whose HTTP request was closed mid-stream. */
const CLIENT_DISCONNECTED = 'CLIENT_DISCONNECTED';

const errorCodeOf = (error: unknown): string =>
  isDomainException(error) ? error.code : ErrorCode.INTERNAL;
