import { sha256Hex } from '@app/common';
import { v7 } from 'uuid';

/**
 * A deterministic uuidv7 for a notification that originates from an external fact (a user
 * registered, a payment succeeded). The 48-bit time part is the fact's time, so the inbox still
 * sorts by time; the 74 "random" bits come from `sha256(sourceKey)`.
 *
 * Why: Kafka delivery is at-least-once. Re-processing the same fact yields the SAME primary key,
 * so the Cassandra INSERT is an idempotent upsert instead of a duplicate inbox entry — no
 * read-before-write or LWT needed.
 */
export function deriveNotificationId(sourceKey: string, occurredAt: Date): string {
  const random = Uint8Array.from(Buffer.from(sha256Hex(sourceKey), 'hex').subarray(0, 16));
  return v7({ msecs: occurredAt.getTime(), random });
}
