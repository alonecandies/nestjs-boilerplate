import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { AiDisabledError, type AiStreamResult, AiTimeoutError } from '@platform/ai';
import { generateId } from '@platform/common';
import { ConversationNotFoundException } from '../../../domain/ai.errors.js';
import type { Message, UsageOutcome, UsageRecord } from '../../../domain/ai.types.js';
import { chatRequestHash } from '../../../domain/chat-request-hash.js';
import { requireCaller } from '../../caller-scope.js';
import type {
  ChatStreamEvent,
  ChatStreamUsage,
  StreamMessageRequest,
} from '../../ports/ai.port.js';
import { ChatTurnHandler, matchReplay } from '../chat-turn.handler.js';
import { StreamMessageCommand } from './stream-message.command.js';

/** One streamed turn after `prepare`: what the stream needs to store its end. */
interface StreamTurn {
  readonly request: StreamMessageRequest;
  readonly requestHash: string;
  readonly userMessage: Message;
  readonly call: AiStreamResult;
  /** Aborts the upstream call when the consumer stops reading. */
  readonly cancel: AbortController;
  /** The signal the call runs under: the caller's and `cancel`'s. */
  readonly signal: AbortSignal;
  readonly startedAt: number;
}

/**
 * One chat turn, streamed. The same unit-of-work steps as `SendMessageHandler`
 * (`ChatTurnHandler`): the read before the call, then `AiClient.stream` with no transaction open,
 * then the write. `execute` resolves once the call started, so refusals (404, 409, 422, 503) reach
 * the client as a plain error, before any event.
 *
 * The returned stream yields each text delta, then stores the reply and yields `done`. A stream cut
 * short stores what it has, exactly once:
 * - the caller's `signal` aborts (the client disconnected), or the consumer stops reading (the
 *   upstream call is then aborted here): outcome `aborted`;
 * - the call fails or times out after it started: outcome `error` / `timeout`, rethrown to the
 *   consumer.
 * With text received, the user message and an `incomplete` assistant reply (with the
 * `Idempotency-Key`, so a replay returns it) are stored with the usage row; without any, only the
 * usage row. Token counts of a cut call are unknown and recorded as 0.
 */
@CommandHandler(StreamMessageCommand)
export class StreamMessageHandler
  extends ChatTurnHandler
  implements ICommandHandler<StreamMessageCommand>
{
  async execute({ request }: StreamMessageCommand): Promise<AsyncIterable<ChatStreamEvent>> {
    requireCaller(request);
    if (!this.config.enabled) throw new AiDisabledError();
    const requestHash = chatRequestHash(request);

    const prepared = await this.prepare(request, requestHash);
    if (prepared.kind === 'replay') return replayOf(prepared.message);

    const model = request.model ?? prepared.conversation.model;
    const userMessage = this.newMessage(request, { role: 'user', content: request.content });
    const cancel = new AbortController();
    const signal =
      request.signal === undefined
        ? cancel.signal
        : AbortSignal.any([request.signal, cancel.signal]);
    // Guard refusals (disabled, model, input size) throw here, before any event or usage row.
    const call = this.ai.stream({
      model,
      messages: this.promptOf(prepared.history, userMessage),
      signal,
    });
    return this.run({
      request,
      requestHash,
      userMessage,
      call,
      cancel,
      signal,
      startedAt: performance.now(),
    });
  }

  private async *run(turn: StreamTurn): AsyncGenerator<ChatStreamEvent> {
    const { request, call } = turn;
    let text = '';
    let settled = false;
    try {
      for await (const delta of call.result.textStream) {
        if (delta === '') continue;
        text += delta;
        yield { type: 'delta', text: delta };
      }
      // Rejects on abort, timeout and upstream failure, whatever the text stream did.
      const total = await call.usage;
      settled = true;
      const usage: ChatStreamUsage = {
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        costUsd: total.costUsd ?? null,
      };
      const reply = this.reply(turn, text, 'complete', usage);
      const stored = await this.store(turn.userMessage, reply, {
        ...this.usageOf(turn, reply.id, 'success'),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
      });
      this.logger.debug(
        `AI chat stream conversation=${request.conversationId} message=${reply.id} ` +
          `model=${call.model} inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens} ` +
          `stored=${stored.kind}`,
      );
      switch (stored.kind) {
        case 'gone':
          throw new ConversationNotFoundException(request.conversationId);
        case 'replay':
          yield {
            type: 'done',
            message: matchReplay(stored.message, turn.requestHash),
            replayed: true,
            usage,
          };
          return;
        default:
          yield { type: 'done', message: stored.message, replayed: false, usage };
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        await this.storeCut(turn, text, error, outcomeOf(error, turn.signal));
      }
      throw error;
    } finally {
      if (!settled) {
        // The consumer stopped reading (`return()`): no tokens are spent for nobody.
        settled = true;
        turn.cancel.abort();
        await this.storeCut(turn, text, turn.signal.reason, 'aborted');
      }
    }
  }

  /** Stores a stream cut short once (best effort: the stream's own error is what counts). */
  private async storeCut(
    turn: StreamTurn,
    text: string,
    error: unknown,
    outcome: UsageOutcome,
  ): Promise<void> {
    const { request, call } = turn;
    const latencyMs = Math.round(performance.now() - turn.startedAt);
    this.logger.debug(
      `AI chat stream cut conversation=${request.conversationId} model=${call.model} ` +
        `outcome=${outcome} received=${text.length > 0}`,
    );
    if (text === '') {
      await this.recordFailure(request, call.model, error, latencyMs, outcome);
      return;
    }
    const reply = this.reply(turn, text, 'incomplete', null);
    try {
      await this.store(turn.userMessage, reply, this.usageOf(turn, reply.id, outcome));
    } catch (storeError) {
      this.logger.warn(
        `Could not store the incomplete reply of conversation ${request.conversationId}: ` +
          (storeError instanceof Error ? storeError.name : typeof storeError),
      );
    }
  }

  private reply(
    turn: StreamTurn,
    text: string,
    status: Message['status'],
    usage: ChatStreamUsage | null,
  ): Message {
    const { request } = turn;
    return this.newMessage(request, {
      role: 'assistant',
      content: text,
      status,
      model: turn.call.model,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      idempotencyKey: request.idempotencyKey ?? null,
      requestHash: request.idempotencyKey === undefined ? null : turn.requestHash,
    });
  }

  private usageOf(turn: StreamTurn, messageId: string, outcome: UsageOutcome): UsageRecord {
    const { request } = turn;
    return {
      tenantId: request.tenantId,
      id: generateId(),
      userId: request.userId,
      conversationId: request.conversationId,
      messageId,
      model: turn.call.model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      latencyMs: Math.round(performance.now() - turn.startedAt),
      outcome,
      createdAt: new Date(),
    };
  }
}

/** A replayed `Idempotency-Key`: the stored reply as the only event, no model call. */
async function* replayOf(message: Message): AsyncGenerator<ChatStreamEvent> {
  yield { type: 'done', message, replayed: true, usage: null };
}

function outcomeOf(error: unknown, signal: AbortSignal): UsageOutcome {
  if (error instanceof AiTimeoutError) return 'timeout';
  return signal.aborted ? 'aborted' : 'error';
}
