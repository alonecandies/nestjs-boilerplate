import Handlebars from 'handlebars';
import { get, includes, inRange, isNumber } from 'lodash-es';

/**
 * nodemailer codes that fail the same way on every attempt: no valid recipients (`EENVELOPE`), a
 * missing template file (`ENOENT`), or a message that can't be built (`EMESSAGE`).
 */
const PERMANENT_CODES = ['EENVELOPE', 'ENOENT', 'EMESSAGE'];

/**
 * `true` when retrying cannot help, so the job should fail right away instead of burning
 * retries:
 * - Handlebars errors: an unknown variable in strict mode, or a missing partial.
 * - SMTP 5xx replies: permanent rejections such as 550 "mailbox unavailable" or 553 "bad address".
 * - The permanent nodemailer codes above.
 *
 * 4xx replies (greylisting, 421 "try again later") and socket errors stay retryable.
 */
export function isPermanentMailError(error: unknown): boolean {
  if (error instanceof Handlebars.Exception) return true;
  const responseCode: unknown = get(error, 'responseCode');
  if (isNumber(responseCode) && inRange(responseCode, 500, 600)) return true;
  return includes(PERMANENT_CODES, get(error, 'code'));
}
