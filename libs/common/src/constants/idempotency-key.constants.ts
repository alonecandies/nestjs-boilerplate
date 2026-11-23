/*
 * The public `Idempotency-Key` contract (header, GraphQL input field, gRPC field), owned here so
 * every context validates it alike. Contexts keep only their own error codes (key reused, etc.).
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * `Idempotency-Key` charset: printable, header- and log-safe (UUIDs, ULIDs, `order-42:retry`).
 * Store a key per caller and never forward it verbatim to a third party.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** The rule in words, for API docs: `8-255 chars of [A-Za-z0-9._:-]`. */
export const IDEMPOTENCY_KEY_FORMAT = `${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} chars of [A-Za-z0-9._:-]`;
