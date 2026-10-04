import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mailConfig } from '@app/config';
import Handlebars from 'handlebars';
import { describe, expect, it, vi } from 'vitest';
import { AppMailerModule } from './app-mailer.module.js';
import { MailProcessor } from './mail.processor.js';
import { MailService } from './mail.service.js';
import { MAIL_PARTIALS_DIR, MAIL_TEMPLATES, MAIL_TEMPLATES_DIR } from './mailer.constants.js';
import {
  createMailerOptions,
  registerMailPartials,
  SMTP_TIMEOUTS,
} from './mailer-options.factory.js';

describe('AppMailerModule.forRootAsync', () => {
  it('is global, exports MailService and registers the worker by default', () => {
    const module = AppMailerModule.forRootAsync();

    expect(module.global).toBe(true);
    expect(module.exports).toEqual([MailService]);
    expect(module.providers).toEqual([MailService, MailProcessor]);
  });

  it('omits the worker for enqueue-only processes', () => {
    expect(AppMailerModule.forRootAsync({ worker: false }).providers).toEqual([MailService]);
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

  it('omits auth when no SMTP credentials are configured (local Mailpit)', () => {
    expect(createMailerOptions(mailConfig.parse({})).transport).not.toHaveProperty('auth');
  });

  it('points at template files that exist', () => {
    for (const template of MAIL_TEMPLATES) {
      expect(existsSync(join(MAIL_TEMPLATES_DIR, `${template}.hbs`))).toBe(true);
    }
    expect(existsSync(join(MAIL_PARTIALS_DIR, 'header.hbs'))).toBe(true);
    expect(existsSync(join(MAIL_PARTIALS_DIR, 'footer.hbs'))).toBe(true);
  });
});
