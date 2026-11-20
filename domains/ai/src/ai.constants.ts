/**
 * Stable error codes of the ai context's chat API (`DomainException.code`, surfaced to clients).
 * The model call's own codes (`AI_DISABLED`, `AI_MODEL_NOT_ALLOWED`, …) are `@platform/ai`'s
 * `AiErrorCode`. Part of the public API: never rename a value.
 */
export const AiChatErrorCode = {
  /** 404: no conversation with this id among the caller's (another user's is never visible). */
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  /** 409: an `Idempotency-Key` replayed with a different message (content or model). */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** 403: the request names a tenant or user other than the caller's principal. */
  TENANT_MISMATCH: 'TENANT_MISMATCH',
} as const;
export type AiChatErrorCode = (typeof AiChatErrorCode)[keyof typeof AiChatErrorCode];

export const AI_LIMITS = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  TITLE_MAX_LENGTH: 200,
  MODEL_MAX_LENGTH: 200,
  /** One message's text; the whole request is also capped by `AI_MAX_INPUT_CHARS`. */
  MESSAGE_MAX_LENGTH: 100_000,
  IDEMPOTENCY_KEY_MIN_LENGTH: 8,
  IDEMPOTENCY_KEY_MAX_LENGTH: 255,
} as const;

/** `Idempotency-Key` charset: printable, header- and log-safe (UUIDs, ULIDs, `msg-42:retry`). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Characters per token of the history budget (`AI_HISTORY_MAX_TOKENS`): an approximation. */
export const APPROX_CHARS_PER_TOKEN = 4;
