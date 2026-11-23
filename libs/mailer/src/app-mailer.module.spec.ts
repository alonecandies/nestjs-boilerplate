import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mailConfig } from '@platform/config';
import Handlebars from 'handlebars';
import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_MORE_TEMPLATES_DIR,
  FIXTURE_TEMPLATE_DIRS,
  FIXTURE_TEMPLATES_DIR,
} from '../test/fixtures/template-dirs.js';
import { AppMailerModule } from './app-mailer.module.js';
import { MailProcessor } from './mail.processor.js';
import { MailService } from './mail.service.js';
import { MAIL_JOBS_TOTAL, MAIL_PARTIALS_DIR } from './mailer.constants.js';
import {
  createMailerOptions,
  listMailTemplates,
  registerMailPartials,
  SMTP_TIMEOUTS,
} from './mailer-options.factory.js';

describe('AppMailerModule.forRootAsync', () => {
  it('is global, exports MailService and registers the worker by default', () => {
    const module = AppMailerModule.forRootAsync({ templateDirs: FIXTURE_TEMPLATE_DIRS });

    expect(module.global).toBe(true);
    expect(module.exports).toEqual([MailService]);
    expect(module.providers).toEqual([
      MailService,
      expect.objectContaining({ provide: `PROM_METRIC_${MAIL_JOBS_TOTAL.toUpperCase()}` }),
      MailProcessor,
    ]);
  });

  it('omits the worker for enqueue-only processes, which need no template dir', () => {
    expect(AppMailerModule.forRootAsync({ templateDirs: [], worker: false }).providers).toEqual([
      MailService,
    ]);
  });

  it('refuses a mail worker without template dirs (it could render nothing)', () => {
    expect(() => AppMailerModule.forRootAsync({ templateDirs: [] })).toThrow(
      'AppMailerModule: a process that delivers mail (worker) needs at least one template dir',
    );
  });
});

describe('createMailerOptions', () => {
  it('maps the mail namespace to a pooled SMTP transport with bounded timeouts', () => {
    const options = createMailerOptions(
      mailConfig.parse({
        SMTP_HOST: 'smtp.acme.test',
        SMTP_PORT: '587',
        SMTP_USER: 'u',
        SMTP_PASSWORD: 'p',
        SMTP_MAX_CONNECTIONS: '8',
        MAIL_FROM: 'Acme <no-reply@acme.test>',
      }),
    );

    expect(options.transport).toEqual({
      host: 'smtp.acme.test',
      port: 587,
      secure: false,
      requireTLS: false,
      auth: { user: 'u', pass: 'p' },
      pool: true,
      maxConnections: 8,
      ...SMTP_TIMEOUTS,
    });
    expect(options.defaults).toEqual({ from: 'Acme <no-reply@acme.test>' });
    expect(options.verifyTransporters).toBe(false);
    expect(options.template?.options).toEqual({ strict: true });
    // Partials are registered once at boot, not re-read by the adapter on every mail.
    expect(options.options).toBeUndefined();
  });

  it('precompiles and registers the shared partials once on the adapter Handlebars env', () => {
    const registerPartial = vi.spyOn(Handlebars, 'registerPartial');

    createMailerOptions(mailConfig.parse({}));

    const registered = registerPartial.mock.calls.map((args: unknown[]) => [
      args[0],
      typeof args[1],
    ]);
    expect(registered).toEqual(
      expect.arrayContaining([
        ['header', 'function'],
        ['footer', 'function'],
        ['button', 'function'],
      ]),
    );
    expect(registerMailPartials()).toEqual(['button', 'footer', 'header']);
    expect(typeof Handlebars.partials.header).toBe('function');
  });

  it('makes STARTTLS mandatory (nodemailer requireTLS) when the mail namespace requires TLS', () => {
    const production = mailConfig.parse({
      NODE_ENV: 'production',
      SMTP_HOST: 'smtp.sendgrid.net',
      MAIL_FROM: 'Acme <no-reply@acme.io>',
    });
    expect(createMailerOptions(production).transport).toMatchObject({
      secure: false,
      requireTLS: true,
    });
  });

  it('omits auth when no SMTP credentials are configured (local Mailpit)', () => {
    expect(createMailerOptions(mailConfig.parse({})).transport).not.toHaveProperty('auth');
  });

  it('ships the shared layout partials', () => {
    for (const partial of ['header', 'footer', 'button']) {
      expect(existsSync(join(MAIL_PARTIALS_DIR, `${partial}.hbs`))).toBe(true);
    }
  });

  it('registers the template dirs in order: the first as `dir`, every one in `dirs`', () => {
    const options = createMailerOptions(mailConfig.parse({}), FIXTURE_TEMPLATE_DIRS);

    expect(options.template?.dir).toBe(FIXTURE_TEMPLATES_DIR);
    expect(options.template?.dirs).toEqual([FIXTURE_TEMPLATES_DIR, FIXTURE_MORE_TEMPLATES_DIR]);
  });

  it('fails at boot on a template dir that does not exist', () => {
    expect(() =>
      createMailerOptions(mailConfig.parse({}), ['/nonexistent/mail-templates']),
    ).toThrow('Mail template dir not found: /nonexistent/mail-templates');
  });

  it('fails at boot when two dirs define the same template name', () => {
    expect(() =>
      createMailerOptions(mailConfig.parse({}), [FIXTURE_TEMPLATES_DIR, FIXTURE_TEMPLATES_DIR]),
    ).toThrow(
      `Mail template "greeting" is defined in both ${FIXTURE_TEMPLATES_DIR} and ${FIXTURE_TEMPLATES_DIR}`,
    );
  });
});

describe('listMailTemplates', () => {
  it('lists the template names of every dir, sorted', () => {
    expect(listMailTemplates(FIXTURE_TEMPLATE_DIRS)).toEqual(['farewell', 'greeting']);
  });
});
