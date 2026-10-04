import type { MailConfig } from '@app/config';
import type { MailerOptions } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { pickBy } from 'lodash-es';
import type { SendMailOptions } from 'nodemailer';
import { MAIL_TEMPLATE_HELPERS } from './mail-template.helpers.js';
import { MAIL_PARTIALS_DIR, MAIL_TEMPLATES_DIR } from './mailer.constants.js';

/**
 * SMTP socket timeouts. nodemailer's defaults (2 min connect, 10 min idle socket) would let a hung
 * server pin a queue worker slot for minutes. The job fails fast instead, and BullMQ retries it.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;

/** Hard cap for a single `sendMail` call (render + SMTP transaction). */
export const MAIL_SEND_TIMEOUT_MS = 45_000;

/**
 * `MailerModule` options built from the `mail` namespace:
 * - Pooled SMTP (`SMTP_POOL`), which reuses TLS sessions across mails.
 * - Handlebars in strict mode, so an unknown variable throws instead of rendering blank.
 * - Shared partials (`header`, `footer`, `button`).
 * - CSS inlining is off because the templates are already inline-styled (it saves an HTML
 *   parse per mail).
 * - `verifyTransporters: false`, so an SMTP outage never blocks boot. The queue absorbs it.
 */
export function createMailerOptions(cfg: MailConfig): MailerOptions {
  const transport = pickBy(
    {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.auth,
      pool: cfg.pool,
      maxConnections: cfg.maxConnections,
      ...SMTP_TIMEOUTS,
    },
    (value) => value !== undefined,
  );
  return {
    transport,
    // The mailer's typings type `defaults` as *transport* options (@types/nodemailer era), and
    // nodemailer 10's bundled types keep message defaults separate, so a cast is needed.
    // The runtime shape is what nodemailer expects.
    defaults: { from: cfg.from } satisfies SendMailOptions as MailerOptions['defaults'],
    template: {
      dir: MAIL_TEMPLATES_DIR,
      adapter: new HandlebarsAdapter(MAIL_TEMPLATE_HELPERS, { inlineCssEnabled: false }),
      options: { strict: true },
    },
    options: {
      partials: { dir: MAIL_PARTIALS_DIR, options: { strict: true } },
    },
    verifyTransporters: false,
    sendTimeout: MAIL_SEND_TIMEOUT_MS,
  };
}
