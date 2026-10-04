import { v7 as uuidv7, validate, version } from 'uuid';

/**
 * New entity/correlation id: UUIDv7 is time-ordered, so it doubles as a keyset-pagination cursor
 * and keeps B-tree inserts append-only (no random page splits like v4).
 */
export const generateId = (): string => uuidv7();

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && validate(value);

export const isUuidV7 = (value: unknown): value is string => isUuid(value) && version(value) === 7;

/** Unix-ms creation time embedded in the first 48 bits of a UUIDv7. */
export function uuidV7Timestamp(id: string): Date {
  if (!isUuidV7(id)) throw new TypeError('Expected a UUIDv7');
  return new Date(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16));
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Whether an incoming `x-request-id` / `x-correlation-id` is safe to adopt. Anything else is
 * replaced: echoing arbitrary client input into headers and logs enables log injection and
 * unbounded-cardinality attacks.
 */
export const isSafeRequestId = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_REQUEST_ID.test(value);
