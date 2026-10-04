import { mapWithConcurrency } from '@app/common';
import { defineMail, MailService } from '@app/mailer';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { countBy, filter, take } from 'lodash-es';
import {
  DIGEST_CONCURRENCY,
  DIGEST_ITEMS_PER_MAIL,
  DIGEST_MAX_RECIPIENTS,
  DIGEST_RECIPIENTS_PAGE_SIZE,
  DIGEST_SCAN_PER_USER,
} from '../../../notifications.constants.js';
import {
  type NotificationRecipient,
  NotificationRecipientsRepository,
} from '../../ports/notification-recipients.repository.js';
import { NotificationsRepository } from '../../ports/notifications.repository.js';
import { type DailyDigestResult, SendDailyDigestCommand } from './send-daily-digest.command.js';

type DigestOutcome = 'enqueued' | 'skipped' | 'failed';

/** `2026-09-29` (UTC) — the day component of the per-recipient idempotency key. */
const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Bounded demo of a batch job over Cassandra: pages through the recipients projection (token
 * order, `maxRecipients` cap), reads each recipient's newest notifications (one partition read,
 * at most `DIGEST_CONCURRENCY` in flight) and queues a digest for those with unread items. The
 * idempotency key `digest-<user>-<day>` makes a re-run on the same day (another replica after a
 * lock expiry, a manual trigger) a no-op in the mail queue.
 */
@CommandHandler(SendDailyDigestCommand)
export class SendDailyDigestHandler implements ICommandHandler<SendDailyDigestCommand> {
  private readonly logger = new Logger(SendDailyDigestHandler.name);

  constructor(
    private readonly recipients: NotificationRecipientsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly mail: MailService,
  ) {}

  async execute({ options }: SendDailyDigestCommand): Promise<DailyDigestResult> {
    const maxRecipients = options.maxRecipients ?? DIGEST_MAX_RECIPIENTS;
    const day = utcDay(options.now ?? new Date());
    const result: DailyDigestResult = { scanned: 0, enqueued: 0, failed: 0 };
    let pageState: string | undefined;

    while (result.scanned < maxRecipients) {
      const pageSize = Math.min(DIGEST_RECIPIENTS_PAGE_SIZE, maxRecipients - result.scanned);
      const page = await this.recipients.scan(pageSize, pageState);
      const outcomes = await mapWithConcurrency(page.items, DIGEST_CONCURRENCY, (recipient) =>
        this.digest(recipient, day),
      );
      const counts = countBy(outcomes);
      result.scanned += page.items.length;
      result.enqueued += counts.enqueued ?? 0;
      result.failed += counts.failed ?? 0;
      // An empty page can still carry a state when the previous one ended on a boundary.
      if (!page.pageState || page.items.length === 0) break;
      pageState = page.pageState;
    }

    return result;
  }

  private async digest(recipient: NotificationRecipient, day: string): Promise<DigestOutcome> {
    try {
      const recent = await this.notifications.findRecentByUser(
        recipient.userId,
        DIGEST_SCAN_PER_USER,
      );
      const unread = filter(recent, (notification) => !notification.read);
      if (unread.length === 0) return 'skipped';
      await this.mail.enqueue(
        defineMail({
          to: recipient.email,
          subject: `You have ${unread.length} unread notification${unread.length === 1 ? '' : 's'}`,
          template: 'daily-digest',
          context: {
            displayName: recipient.displayName || undefined,
            unreadCount: unread.length,
            items: take(unread, DIGEST_ITEMS_PER_MAIL).map(({ title, body, createdAt }) => ({
              title,
              body,
              createdAt: createdAt.toISOString(),
            })),
          },
          idempotencyKey: `digest-${recipient.userId}-${day}`,
        }),
      );
      return 'enqueued';
    } catch (error) {
      // One broken recipient must not abort the whole run.
      this.logger.warn(
        `Daily digest for user ${recipient.userId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
  }
}
