import type { LoggerService } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** How `subscribeToChannel` reports a failed `SUBSCRIBE`. */
export interface ChannelSubscriptionOptions {
  /** Warned with the channel and the error (never a message payload). */
  readonly logger: Pick<LoggerService, 'warn'>;
  /**
   * Called after the warning, for a caller that wants to stop listening or retry later. Without
   * it the listener stays attached.
   */
  readonly onError?: (error: unknown) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Listens to one pub/sub `channel` on a subscriber connection (`REDIS_SUBSCRIBER`, shared by every
 * listener of the process): attaches a `message` listener that hands `onMessage` the payloads of
 * that channel only, and sends `SUBSCRIBE` without awaiting it. The subscriber connects lazily and
 * must not block boot while Redis starts, and ioredis re-subscribes after a reconnect. A failed
 * `SUBSCRIBE` is logged (`cannot subscribe to <channel>: <error>`), then `options.onError` runs.
 *
 * Returns an idempotent removal that detaches the listener only: it never sends `UNSUBSCRIBE`, so
 * another listener of the same channel on the shared connection keeps receiving it. The payload
 * comes from every replica and version on the channel: parse it defensively.
 */
export function subscribeToChannel(
  subscriber: Redis,
  channel: string,
  onMessage: (message: string) => void,
  options: ChannelSubscriptionOptions,
): () => void {
  const listener = (received: string, message: string): void => {
    if (received === channel) onMessage(message);
  };
  let attached = true;
  const remove = (): void => {
    if (!attached) return;
    attached = false;
    subscriber.off('message', listener);
  };
  subscriber.on('message', listener);
  subscriber.subscribe(channel).catch((error: unknown) => {
    options.logger.warn(`cannot subscribe to ${channel}: ${errorMessage(error)}`);
    options.onError?.(error);
  });
  return remove;
}
