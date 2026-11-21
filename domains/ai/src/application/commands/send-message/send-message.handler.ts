import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { AiDisabledError, type AiGenerateResult } from '@platform/ai';
import { generateId } from '@platform/common';
import { ConversationNotFoundException } from '../../../domain/ai.errors.js';
import type { UsageRecord } from '../../../domain/ai.types.js';
import { chatRequestHash } from '../../../domain/chat-request-hash.js';
import { requireCaller } from '../../caller-scope.js';
import type { SendMessageResult } from '../../ports/ai.port.js';
import { ChatTurnHandler, matchReplay } from '../chat-turn.handler.js';
import { SendMessageCommand } from './send-message.command.js';

/**
 * One chat turn, non-streaming (the unit-of-work steps are `ChatTurnHandler`'s):
 *
 * 1. Read, in one unit of work as the caller: the conversation (404 when it is not the caller's),
 *    a stored reply for the `Idempotency-Key` (same request hash → returned without a call,
 *    another → 409), and the history (`AI_HISTORY_MAX_MESSAGES` newest).
 * 2. Call the model with the history window (count, approximate token budget, and what
 *    `AI_MAX_INPUT_CHARS` leaves after the new message and the tool instructions: the oldest
 *    messages go first) then the new user message. No transaction is open during the call.
 * 3. Write, in one unit of work as the caller: the conversation again, the assistant reply with the
 *    key and request hash first, the user message, the usage row and the conversation's `updatedAt`.
 *
 * With tools bound, the call may run read-only tools as the caller (`AiChatTools`, at most
 * `AI_MAX_TOOL_STEPS` model steps, the last of which answers without calling one); its tool calls
 * and results are stored between the user message and the reply. A model that calls a tool on the
 * last step anyway fails the call (502 `AI_UPSTREAM_ERROR`): no message is stored.
 *
 * A failed call stores no message and records a usage row with the failure outcome (`error`,
 * `timeout`); a call refused by a guard (disabled, model, input size) records nothing. Logs carry
 * ids, model and token counts only, never message text.
 */
@CommandHandler(SendMessageCommand)
export class SendMessageHandler
  extends ChatTurnHandler
  implements ICommandHandler<SendMessageCommand>
{
  async execute({ request }: SendMessageCommand): Promise<SendMessageResult> {
    const caller = requireCaller(request);
    if (!this.config.enabled) throw new AiDisabledError();
    const requestHash = chatRequestHash(request);

    const prepared = await this.prepare(request, requestHash);
    if (prepared.kind === 'replay') return { message: prepared.message, replayed: true };

    const model = request.model ?? prepared.conversation.model;
    const userMessage = this.newMessage(request, { role: 'user', content: request.content });
    const startedAt = performance.now();
    let result: AiGenerateResult;
    try {
      result = await this.ai.generate({
        model,
        ...this.promptOf(caller, prepared.history, userMessage),
      });
    } catch (error) {
      await this.recordFailure(request, model, error, Math.round(performance.now() - startedAt));
      throw error;
    }

    const steps = this.stepMessages(request, result.model, result.result.responseMessages);
    const reply = this.newMessage(request, {
      role: 'assistant',
      content: result.text,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      idempotencyKey: request.idempotencyKey ?? null,
      requestHash: request.idempotencyKey === undefined ? null : requestHash,
    });
    const usage: UsageRecord = {
      tenantId: request.tenantId,
      id: generateId(),
      userId: request.userId,
      conversationId: request.conversationId,
      messageId: reply.id,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd ?? null,
      latencyMs: result.latencyMs,
      outcome: 'success',
      createdAt: reply.createdAt,
    };
    const stored = await this.store(userMessage, reply, usage, steps);
    this.logger.debug(
      `AI chat turn conversation=${request.conversationId} message=${reply.id} model=${result.model} ` +
        `inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens} stored=${stored.kind}`,
    );
    switch (stored.kind) {
      case 'gone':
        throw new ConversationNotFoundException(request.conversationId);
      case 'replay':
        return { message: matchReplay(stored.message, requestHash), replayed: true };
      default:
        return { message: stored.message, replayed: false };
    }
  }
}
