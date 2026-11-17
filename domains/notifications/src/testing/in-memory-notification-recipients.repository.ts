import type {
  NotificationRecipient,
  NotificationRecipientsRepository,
  NotificationRecipientsSlice,
} from '../application/ports/notification-recipients.repository.js';

interface Cell {
  /** The last upsert, or undefined when only a delete was seen. */
  row?: NotificationRecipient;
  /** Write timestamp of `row` (ms; the Cassandra adapter binds microseconds). */
  writtenAt: number;
  /** Highest delete timestamp seen; a write stamped at or before it stays invisible. */
  deletedAt: number;
}

const keyOf = (tenantId: string, userId: string): string => `${tenantId}/${userId}`;

/**
 * `NotificationRecipientsRepository` in memory, with the Cassandra adapter's last-write-wins
 * semantics: writes are stamped (`updatedAt`, `removedAt`), a delete shadows every write stamped at
 * or before it, and an older write never replaces a newer one. `scan` pages in key order with a
 * hex page state.
 */
export class InMemoryNotificationRecipientsRepository implements NotificationRecipientsRepository {
  private readonly cells = new Map<string, Cell>();

  upsert(recipient: NotificationRecipient): Promise<void> {
    const key = keyOf(recipient.tenantId, recipient.userId);
    const stamp = recipient.updatedAt.getTime();
    const cell = this.cells.get(key) ?? {
      writtenAt: Number.NEGATIVE_INFINITY,
      deletedAt: Number.NEGATIVE_INFINITY,
    };
    if (cell.row === undefined || stamp >= cell.writtenAt) {
      cell.row = { ...recipient };
      cell.writtenAt = stamp;
    }
    this.cells.set(key, cell);
    return Promise.resolve();
  }

  find(tenantId: string, userId: string): Promise<NotificationRecipient | null> {
    return Promise.resolve(this.visible(this.cells.get(keyOf(tenantId, userId))));
  }

  remove(tenantId: string, userId: string, removedAt: Date = new Date()): Promise<void> {
    const key = keyOf(tenantId, userId);
    const cell = this.cells.get(key) ?? {
      writtenAt: Number.NEGATIVE_INFINITY,
      deletedAt: Number.NEGATIVE_INFINITY,
    };
    cell.deletedAt = Math.max(cell.deletedAt, removedAt.getTime());
    this.cells.set(key, cell);
    return Promise.resolve();
  }

  scan(limit: number, pageState?: string): Promise<NotificationRecipientsSlice> {
    const all = [...this.cells.keys()]
      .sort()
      .map((key) => this.visible(this.cells.get(key)))
      .filter((row): row is NotificationRecipient => row !== null);
    const offset = pageState ? Number.parseInt(pageState, 16) : 0;
    const end = offset + Math.max(1, Math.trunc(limit));
    const next = end < all.length ? end.toString(16).padStart(2, '0') : null;
    return Promise.resolve({ items: all.slice(offset, end), pageState: next });
  }

  /** Every visible recipient (test assertions). */
  all(): NotificationRecipient[] {
    return [...this.cells.values()]
      .map((cell) => this.visible(cell))
      .filter((row): row is NotificationRecipient => row !== null);
  }

  private visible(cell: Cell | undefined): NotificationRecipient | null {
    if (cell?.row === undefined || cell.writtenAt <= cell.deletedAt) return null;
    return { ...cell.row };
  }
}
