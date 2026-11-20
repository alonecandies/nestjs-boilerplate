import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { ProblemDetails } from '@platform/common';
import type { ChatStreamEvent } from '../../application/ports/ai.port.js';
import { toMessageResponse } from './ai.dto.js';

/** `Content-Type` of the chat stream. */
export const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

/**
 * The SSE event names of `POST /v1/ai/conversations/:id/messages/stream` (a wire contract):
 * `delta` `{ text }` for each chunk in order, then exactly one of `done`
 * `{ message, replayed, usage }` (the stored reply, as REST `AiMessage`) or `error` (an RFC 9457
 * problem document).
 */
export const AI_SSE_EVENTS = { DELTA: 'delta', DONE: 'done', ERROR: 'error' } as const;

/** The slice of the Fastify reply the stream writes through (`@Res()`). */
export interface SseReply {
  readonly raw: ServerResponse;
  hijack(): unknown;
  getHeaders(): OutgoingHttpHeaders;
}

/** One SSE frame. `data` is one line of JSON (JSON escapes every newline). */
export const sseFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A chat stream event as its SSE frame. */
export function chatSseFrame(event: ChatStreamEvent): string {
  if (event.type === 'delta') return sseFrame(AI_SSE_EVENTS.DELTA, { text: event.text });
  return sseFrame(AI_SSE_EVENTS.DONE, {
    message: toMessageResponse(event.message),
    replayed: event.replayed,
    usage: event.usage,
  });
}

export interface WriteChatSseOptions {
  /** The client's disconnect: once aborted, nothing more is written. */
  readonly signal: AbortSignal;
  /** The problem document of a failure after the headers went out. */
  readonly problem: (error: unknown) => ProblemDetails;
}

/**
 * Takes the response over from Fastify (`hijack`), sends the SSE headers (with those already set
 * on the reply: request id, rate-limit headers, CORS) and writes each event as it comes, honouring
 * back-pressure. A failure mid-stream becomes an `error` event; after a disconnect the stream is
 * still read to its end (the producer stores the partial reply) but nothing is written. The
 * response always ends.
 */
export async function writeChatSse(
  reply: SseReply,
  events: AsyncIterable<ChatStreamEvent>,
  options: WriteChatSseOptions,
): Promise<void> {
  reply.hijack();
  const { raw } = reply;
  raw.writeHead(200, {
    ...reply.getHeaders(),
    'content-type': SSE_CONTENT_TYPE,
    'cache-control': 'no-cache, no-transform',
    // nginx and similar proxies: do not buffer the stream.
    'x-accel-buffering': 'no',
  });
  raw.flushHeaders();
  const live = (): boolean => !options.signal.aborted && !raw.destroyed;
  try {
    for await (const event of events) {
      if (live()) await write(raw, chatSseFrame(event));
    }
  } catch (error) {
    if (live()) await write(raw, sseFrame(AI_SSE_EVENTS.ERROR, options.problem(error)));
  } finally {
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  }
}

/** Writes `chunk`; when the socket buffer is full, waits for `drain` (or the connection's end). */
function write(raw: ServerResponse, chunk: string): Promise<void> {
  if (raw.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      raw.off('drain', done);
      raw.off('close', done);
      resolve();
    };
    raw.once('drain', done);
    raw.once('close', done);
  });
}
