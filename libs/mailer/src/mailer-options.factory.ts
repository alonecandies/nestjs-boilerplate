import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { MailConfig } from '@app/config';
import type { MailerOptions } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import Handlebars from 'handlebars';
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
 * Compiles every `*.hbs` under `dir` (strict, like the templates) and registers it as a partial
 * named after its path without the extension (`header`, `footer`, `button`) on the global
 * Handlebars environment, which is the one `HandlebarsAdapter` renders with. Called once at boot:
 * the adapter's own `options.partials` support re-globs, re-reads and re-registers every partial
 * (as a string, forcing a recompile) synchronously on every single mail.
 */
export function registerMailPartials(dir: string = MAIL_PARTIALS_DIR): string[] {
  const names: string[] = [];
  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (extname(file) !== '.hbs') continue;
    const name = file.slice(0, -'.hbs'.length).split(sep).join('/');
    const source = readFileSync(join(dir, file), 'utf8');
    Handlebars.registerPartial(name, Handlebars.compile(source, { strict: true }));
    names.push(name);
  }
  return names.sort();
}

/**
 * `MailerModule` options built from the `mail` namespace:
 * - Pooled SMTP (`SMTP_POOL`), which reuses TLS sessions across mails.
 * - Handlebars in strict mode, so an unknown variable throws instead of rendering blank.
 * - Shared partials (`header`, `footer`, `button`), precompiled and registered once here
 *   (`registerMailPartials`) instead of through the adapter's per-mail `options.partials`.
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
  registerMailPartials();
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
    verifyTransporters: false,
    sendTimeout: MAIL_SEND_TIMEOUT_MS,
  };
}
