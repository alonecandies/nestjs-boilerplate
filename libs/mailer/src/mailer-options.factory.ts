import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { MailerOptions } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import type { MailConfig } from '@platform/config';
import Handlebars from 'handlebars';
import { pickBy } from 'lodash-es';
import type { SendMailOptions } from 'nodemailer';
import { MAIL_TEMPLATE_HELPERS } from './mail-template.helpers.js';
import { MAIL_PARTIALS_DIR } from './mailer.constants.js';

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
 * Template names (`*.hbs` file names without the extension) across `templateDirs`, sorted. Throws
 * on a missing dir, and on a name defined in two dirs: `HandlebarsAdapter` resolves a name in
 * `template.dir` first, then in `template.dirs` order, and caches the first file it compiled under
 * that name, so a second definition would be silently ignored.
 */
export function listMailTemplates(templateDirs: readonly string[]): string[] {
  const owners = new Map<string, string>();
  for (const dir of templateDirs) {
    if (!existsSync(dir)) throw new Error(`Mail template dir not found: ${dir}`);
    for (const file of readdirSync(dir)) {
      if (extname(file) !== '.hbs') continue;
      const name = file.slice(0, -'.hbs'.length);
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new Error(`Mail template "${name}" is defined in both ${owner} and ${dir}`);
      }
      owners.set(name, dir);
    }
  }
  return [...owners.keys()].sort();
}

/**
 * `MailerModule` options built from the `mail` namespace and the template dirs the app registers:
 * - Pooled SMTP (`SMTP_POOL`), which reuses TLS sessions across mails.
 * - Handlebars in strict mode, so an unknown variable throws instead of rendering blank.
 * - Templates looked up by name in `templateDirs`, first match wins (the first dir is the
 *   adapter's `template.dir`, every dir is in `template.dirs`). `listMailTemplates` fails boot on
 *   a missing dir or a name defined twice. No dirs: the process can enqueue but not render.
 * - Shared partials (`header`, `footer`, `button`), precompiled and registered once here
 *   (`registerMailPartials`) instead of through the adapter's per-mail `options.partials`.
 * - CSS inlining is off because the templates are already inline-styled (it saves an HTML
 *   parse per mail).
 * - `verifyTransporters: false`, so an SMTP outage never blocks boot. The queue absorbs it.
 */
export function createMailerOptions(
  cfg: MailConfig,
  templateDirs: readonly string[] = [],
): MailerOptions {
  listMailTemplates(templateDirs);
  const transport = pickBy(
    {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      // Refuse to send unless STARTTLS succeeds (SMTP_REQUIRE_TLS; on by default in production).
      requireTLS: cfg.requireTls,
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
      // HandlebarsAdapter looks a name up in `dir`, then in every `dirs` entry, in order.
      dir: templateDirs[0],
      dirs: [...templateDirs],
      adapter: new HandlebarsAdapter(MAIL_TEMPLATE_HELPERS, { inlineCssEnabled: false }),
      options: { strict: true },
    },
    verifyTransporters: false,
    sendTimeout: MAIL_SEND_TIMEOUT_MS,
  };
}
