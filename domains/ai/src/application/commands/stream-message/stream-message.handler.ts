import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  AiDisabledError,
  type AiStreamResult,
  AiTimeoutError,
  type AiUsage,
  aiUsageOf,
} from '@platform/ai';
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
 * A caller whose `signal` aborted before the model call (during `prepare`) gets a stream that
 * rejects with the abort reason on its first read: no model call, no metric and no usage row, as
 * nothing was sent (a refusal's "nothing spent, nothing recorded"). An abort once the call started
 * is a cut (below).
 *
 * The returned stream yields each text delta, then stores the reply and yields `done`. A stream cut
 * short stores what it has, exactly once:
 * - the caller's `signal` aborts (the client disconnected), or the consumer stops reading (the
 *   upstream call is then aborted here): outcome `aborted`, unless the call had already failed
 *   (its deadline, an upstream error); that failure's outcome and usage then count, as in the
 *   metrics;
 * - the call fails or times out after it started: outcome `error` / `timeout`, rethrown to the
 *   consumer.
 * With tools bound, the deltas span every model step (`AI_MAX_TOOL_STEPS` at most, the last of
 * which answers without calling a tool); a complete turn stores the steps' tool calls and results
 * between the user message and the reply, whose content is the last step's text, and `done`
 * carries that reply. A cut turn stores only the text received.
 *
 * With text received, the user message and an `incomplete` assistant reply are stored with the
 * usage row; without any, only the usage row. The row of a cut call holds what its model calls
 * that ended were billed (`aiUsageOf`, read once the stream ended, so a call whose usage came
 * after its error part counts); one cut mid-answer (timeout, abort) reports nothing, so a call cut
 * in its first model call records 0 tokens and no cost. The incomplete reply's own token counts stay
 * unknown (null). It carries no `Idempotency-Key` nor request hash: only a complete reply
 * binds the key, so a retry with it runs a new turn instead of replaying the cut text, and the
 * history of that turn and of later ones leaves out the cut exchange it repeats (`promptOf`).
 */
@CommandHandler(StreamMessageCommand)
export class StreamMessageHandler
  extends ChatTurnHandler
  implements ICommandHandler<StreamMessageCommand>
{
  async execute({ request }: StreamMessageCommand): Promise<AsyncIterable<ChatStreamEvent>> {
    const caller = requireCaller(request);
    if (!this.config.enabled) throw new AiDisabledError();
    const requestHash = chatRequestHash(request);

    const prepared = await this.prepare(request, requestHash);
    if (prepared.kind === 'replay') return replayOf(prepared.message);
    // The client left during prepare: nothing was sent, so no model call, metric or usage row.
    if (request.signal?.aborted === true) return cutBeforeCall(request.signal);

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
      ...this.promptOf(caller, prepared.history, userMessage),
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
    // What the call failed with (its deadline, an upstream error), for a consumer that stops
    // reading after that: the failure, not the stop, is what the cut records.
    let failure: { readonly error: unknown } | undefined;
    call.usage.catch((error: unknown) => {
      failure = { error };
    });
    try {
      for await (const delta of call.result.textStream) {
        if (delta === '') continue;
        text += delta;
        yield { type: 'delta', text: delta };
      }
      // Rejects on abort, timeout and upstream failure, whatever the text stream did.
      const total = await call.usage;
      // With tools: the steps' calls and results, and the last step's text as the reply.
      const responseMessages = await call.result.responseMessages;
      const answer = await call.result.text;
      settled = true;
      const steps = this.stepMessages(request, call.model, responseMessages);
      const usage: ChatStreamUsage = {
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        costUsd: total.costUsd ?? null,
      };
      const reply = this.reply(turn, steps.length === 0 ? text : answer, 'complete', usage);
      const stored = await this.store(
        turn.userMessage,
        reply,
        this.usageOf(turn, reply.id, 'success', total),
        steps,
      );
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
        // The consumer stopped reading (`return()`): no tokens are spent for nobody. Unless the
        // call had already failed: that failure's outcome and usage then count. The outcome is
        // read before the abort, which would make any failure look like an abort.
        settled = true;
        const outcome = failure === undefined ? 'aborted' : outcomeOf(failure.error, turn.signal);
        turn.cancel.abort();
        await this.storeCut(
          turn,
          text,
          failure === undefined ? turn.signal.reason : failure.error,
          outcome,
        );
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
      await this.store(
        turn.userMessage,
        reply,
        this.usageOf(turn, reply.id, outcome, aiUsageOf(error)),
      );
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
    // Only a complete reply binds the key: a cut one leaves it free, so a retry runs a new turn.
    const idempotencyKey = status === 'complete' ? (request.idempotencyKey ?? null) : null;
    return this.newMessage(request, {
      role: 'assistant',
      content: text,
      status,
      model: turn.call.model,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      idempotencyKey,
      requestHash: idempotencyKey === null ? null : turn.requestHash,
    });
  }

  /** The turn's usage row: `usage` is the call's, or what a cut call was billed (none: 0, null). */
  private usageOf(
    turn: StreamTurn,
    messageId: string,
    outcome: UsageOutcome,
    usage: AiUsage | undefined,
  ): UsageRecord {
    const { request } = turn;
    return {
      tenantId: request.tenantId,
      id: generateId(),
      userId: request.userId,
      conversationId: request.conversationId,
      messageId,
      model: turn.call.model,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costUsd: usage?.costUsd ?? null,
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

/**
 * A turn whose client left before the model call: the stream rejects with the abort reason on its
 * first read, and a stream released unread (`return()`) ends quietly. Not thrown from `execute`,
 * so a consumer handles it as any other abort (the SSE route has no reply to answer on).
 */
function cutBeforeCall(signal: AbortSignal): AsyncIterable<ChatStreamEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        signal.throwIfAborted(); // an aborted signal stays aborted: always throws its reason
        return { done: true, value: undefined };
      },
      return: async () => ({ done: true, value: undefined }),
    }),
  };
}

function outcomeOf(error: unknown, signal: AbortSignal): UsageOutcome {
  if (error instanceof AiTimeoutError) return 'timeout';
  return signal.aborted ? 'aborted' : 'error';
}
