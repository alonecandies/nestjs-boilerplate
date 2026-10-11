import { z } from 'zod';

/** `notifications.markRead` message body (validated by the global Standard Schema pipe). */
export const markReadMessageSchema = z.object({ id: z.uuid() });

export type MarkReadMessage = z.output<typeof markReadMessageSchema>;

/** Ack of `notifications.markRead` (errors are acked as `{ ok: false, error }` by the filter). */
export interface MarkReadAck {
  ok: true;
}
