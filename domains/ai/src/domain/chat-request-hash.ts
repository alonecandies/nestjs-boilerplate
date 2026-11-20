import { sha256Hex } from '@platform/common';

/** The send-message fields that decide the reply. */
export interface ChatRequestShape {
  readonly content: string;
  readonly model?: string | undefined;
}

/**
 * sha256 hex of the normalized send-message request, stored on the assistant reply with its
 * `Idempotency-Key`: a replay with the same hash returns the stored reply, any other is a 409. An
 * absent model hashes as `null` (the conversation's model applies, the same for every replay).
 */
export function chatRequestHash(request: ChatRequestShape): string {
  return sha256Hex(JSON.stringify([request.content, request.model ?? null]));
}
