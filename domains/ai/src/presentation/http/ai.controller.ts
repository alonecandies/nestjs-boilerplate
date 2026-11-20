import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { type RequestLike, Timeout, toProblemDetails } from '@platform/common';
import { RateLimit } from '@platform/redis';
import { AI_LIMITS } from '../../ai.constants.js';
import { AiPermission } from '../../ai.permissions.js';
import { AiPort } from '../../application/ports/ai.port.js';
import { abortOnDisconnect } from '../client-disconnect.js';
import { AI_RATE_LIMITS } from '../rate-limit/ai-rate-limit.js';
import {
  type ConversationPageResponse,
  type ConversationResponse,
  type CreateConversationBody,
  conversationIdParamSchema,
  conversationPageResponseSchema,
  conversationResponseSchema,
  createConversationBodySchema,
  type MessagePageResponse,
  messagePageResponseSchema,
  type PageQuery,
  pageQuerySchema,
  type SendMessageBody,
  type SendMessageResponse,
  sendMessageBodySchema,
  sendMessageResponseSchema,
  toConversationPageResponse,
  toConversationResponse,
  toMessagePageResponse,
  toSendMessageResponse,
} from './ai.dto.js';
import { SSE_CONTENT_TYPE, type SseReply, writeChatSse } from './ai-sse.js';
import { IdempotencyKey } from './idempotency-key.decorator.js';

/**
 * `/v1/ai/conversations`: the caller's own conversations and the chat turn (plain or streamed as
 * Server-Sent Events). Depends only on `AiPort`; tenant and user always come from the verified
 * token. Every route needs `ai:chat` (members and above); sending a message (either way) also
 * charges the `ai.chat` policy.
 */
@ApiTags('ai')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked access token.' })
@ApiForbiddenResponse({ description: 'The token lacks `ai:chat`.' })
@Controller({ path: 'ai/conversations', version: '1' })
@RequirePermissions(AiPermission.Chat)
@UseInterceptors(StandardSchemaSerializerInterceptor)
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(private readonly ai: AiPort) {}

  @Post()
  @ApiOperation({ summary: 'Start a conversation' })
  @ApiCreatedResponse({ standardSchema: conversationResponseSchema })
  @ApiBadRequestResponse({ description: 'Invalid body.' })
  @ApiUnprocessableEntityResponse({ description: 'Model not allowed (`AI_MODEL_NOT_ALLOWED`).' })
  @ApiServiceUnavailableResponse({ description: 'AI is disabled (`AI_DISABLED`).' })
  @SerializeOptions({ schema: conversationResponseSchema })
  async create(
    @Body({ schema: createConversationBodySchema }) body: CreateConversationBody,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationResponse> {
    const conversation = await this.ai.createConversation({
      tenantId: user.tenantId,
      userId: user.id,
      title: body.title,
      model: body.model,
    });
    return toConversationResponse(conversation);
  }

  @Get()
  @ApiOperation({ summary: 'List my conversations', description: 'Newest first, keyset pages.' })
  @ApiOkResponse({ standardSchema: conversationPageResponseSchema })
  @ApiBadRequestResponse({ description: 'Invalid `limit` or `cursor`.' })
  @SerializeOptions({ schema: conversationPageResponseSchema })
  async list(
    @Query({ schema: pageQuerySchema }) query: PageQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationPageResponse> {
    const page = await this.ai.listConversations({
      tenantId: user.tenantId,
      userId: user.id,
      limit: query.limit,
      cursor: query.cursor,
    });
    return toConversationPageResponse(page);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of my conversations' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ standardSchema: conversationResponseSchema })
  @ApiNotFoundResponse({ description: 'No such conversation of yours (`CONVERSATION_NOT_FOUND`).' })
  @SerializeOptions({ schema: conversationResponseSchema })
  async get(
    @Param('id', { schema: conversationIdParamSchema }) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationResponse> {
    const conversation = await this.ai.getConversation({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: id,
    });
    return toConversationResponse(conversation);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete one of my conversations',
    description: 'Its messages go with it; usage records stay.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({ description: 'No such conversation of yours (`CONVERSATION_NOT_FOUND`).' })
  async delete(
    @Param('id', { schema: conversationIdParamSchema }) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.ai.deleteConversation({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: id,
    });
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'List the messages of one of my conversations',
    description: 'Newest first.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ standardSchema: messagePageResponseSchema })
  @ApiNotFoundResponse({ description: 'No such conversation of yours (`CONVERSATION_NOT_FOUND`).' })
  @SerializeOptions({ schema: messagePageResponseSchema })
  async listMessages(
    @Param('id', { schema: conversationIdParamSchema }) id: string,
    @Query({ schema: pageQuerySchema }) query: PageQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<MessagePageResponse> {
    const page = await this.ai.listMessages({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: id,
      limit: query.limit,
      cursor: query.cursor,
    });
    return toMessagePageResponse(page);
  }

  @Post(':id/messages')
  @RateLimit(AI_RATE_LIMITS.CHAT)
  // Bounded by AI_REQUEST_TIMEOUT_MS (the model call's deadline), not the default handler timeout.
  @Timeout(0)
  @ApiOperation({
    summary: 'Send a message and get the reply',
    description:
      'Sends the history window and your message to the model and stores both messages. ' +
      'Send an `Idempotency-Key` to make retries return the same reply.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: `Replays with the same key and body return the stored reply (${AI_LIMITS.IDEMPOTENCY_KEY_MIN_LENGTH}-${AI_LIMITS.IDEMPOTENCY_KEY_MAX_LENGTH} chars of [A-Za-z0-9._:-]).`,
  })
  @ApiCreatedResponse({ standardSchema: sendMessageResponseSchema })
  @ApiBadRequestResponse({ description: 'Invalid body or Idempotency-Key.' })
  @ApiNotFoundResponse({ description: 'No such conversation of yours (`CONVERSATION_NOT_FOUND`).' })
  @ApiConflictResponse({
    description: 'Idempotency-Key reused for another message (`IDEMPOTENCY_KEY_REUSED`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Model not allowed or input too long (`AI_MODEL_NOT_ALLOWED`, `AI_INPUT_TOO_LARGE`).',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Over `AI_CHAT_LIMIT` per user or `AI_CHAT_TENANT_LIMIT` per tenant per window (`ai.chat`).',
  })
  @ApiServiceUnavailableResponse({ description: 'AI is disabled (`AI_DISABLED`).' })
  @ApiGatewayTimeoutResponse({ description: 'The model did not answer in time (`AI_TIMEOUT`).' })
  @SerializeOptions({ schema: sendMessageResponseSchema })
  async sendMessage(
    @Param('id', { schema: conversationIdParamSchema }) id: string,
    @Body({ schema: sendMessageBodySchema }) body: SendMessageBody,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SendMessageResponse> {
    const result = await this.ai.sendMessage({
      tenantId: user.tenantId,
      userId: user.id,
      conversationId: id,
      content: body.content,
      model: body.model,
      idempotencyKey,
    });
    return toSendMessageResponse(result);
  }

  @Post(':id/messages/stream')
  @RateLimit(AI_RATE_LIMITS.CHAT)
  // Bounded by AI_REQUEST_TIMEOUT_MS (the model call's deadline), not the default handler timeout.
  @Timeout(0)
  @ApiOperation({
    summary: 'Send a message and stream the reply (Server-Sent Events)',
    description:
      'The same turn as `POST …/messages`, streamed as `text/event-stream`: `delta` events ' +
      '(`{ text }`, in order), then one `done` (`{ message, replayed, usage }`, the stored reply) ' +
      'or one `error` (a problem document). Refusals (404, 409, 422, 429, 503) are plain ' +
      'problem+json responses, sent before any event. Closing the connection aborts the model ' +
      'call; the reply so far is stored as `incomplete`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Replays with the same key and body stream the stored reply as a single `done`.',
  })
  @ApiProduces(SSE_CONTENT_TYPE)
  @ApiOkResponse({
    description: 'The event stream (`delta`…, then `done` or `error`).',
    content: { [SSE_CONTENT_TYPE]: { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'Invalid body or Idempotency-Key.' })
  @ApiNotFoundResponse({ description: 'No such conversation of yours (`CONVERSATION_NOT_FOUND`).' })
  @ApiConflictResponse({
    description: 'Idempotency-Key reused for another message (`IDEMPOTENCY_KEY_REUSED`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Model not allowed or input too long (`AI_MODEL_NOT_ALLOWED`, `AI_INPUT_TOO_LARGE`).',
  })
  @ApiTooManyRequestsResponse({
    description: 'Over the `ai.chat` budget (charged before the model call).',
  })
  @ApiServiceUnavailableResponse({ description: 'AI is disabled (`AI_DISABLED`).' })
  async streamMessage(
    @Param('id', { schema: conversationIdParamSchema }) id: string,
    @Body({ schema: sendMessageBodySchema }) body: SendMessageBody,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentUser() user: AuthUser,
    @Req() request: RequestLike,
    @Res() reply: SseReply,
  ): Promise<void> {
    // Watch the connection before the turn starts: a client gone during the read aborts the call.
    const disconnect = abortOnDisconnect(reply.raw);
    try {
      const events = await this.ai.streamMessage({
        tenantId: user.tenantId,
        userId: user.id,
        conversationId: id,
        content: body.content,
        model: body.model,
        idempotencyKey,
        signal: disconnect.signal,
      });
      await writeChatSse(reply, events, {
        signal: disconnect.signal,
        problem: (error) => this.problemOf(error, request),
      });
    } finally {
      disconnect.dispose();
    }
  }

  /** The `error` event of a failure after the headers (the exception filter no longer can). */
  private problemOf(error: unknown, request: RequestLike) {
    const url = request.url ?? '';
    const query = url.indexOf('?');
    const problem = toProblemDetails(error, {
      requestId: request.id,
      instance: query === -1 ? url : url.slice(0, query),
      exposeInternal: false,
    });
    const line = `AI stream failed after the headers: status=${problem.status} code=${problem.code}`;
    if (problem.status >= 500) this.logger.warn(line);
    else this.logger.debug(line);
    return problem;
  }
}
