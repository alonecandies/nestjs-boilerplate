import { describe, expect, it } from 'vitest';
import { mailConfig } from './mail.config.js';

const prod = {
  NODE_ENV: 'production',
  SMTP_HOST: 'smtp.acme.io',
  MAIL_FROM: 'Acme <no-reply@acme.io>',
};

describe('MAIL_APP_URL (F34)', () => {
  it('is optional and drops a trailing slash', () => {
    expect(mailConfig.parse({}).appUrl).toBeUndefined();
    expect(mailConfig.parse({ MAIL_APP_URL: 'http://localhost:3000/' }).appUrl).toBe(
      'http://localhost:3000',
    );
  });

  it('rejects other schemes', () => {
    expect(() => mailConfig.parse({ MAIL_APP_URL: 'javascript:alert(1)' })).toThrow();
  });

  it('must be https in production, unless SMTP_ALLOW_INSECURE (local compose)', () => {
    expect(() => mailConfig.parse({ ...prod, MAIL_APP_URL: 'http://app.acme.io' })).toThrow(
      /MAIL_APP_URL/,
    );
    expect(mailConfig.parse({ ...prod, MAIL_APP_URL: 'https://app.acme.io' }).appUrl).toBe(
      'https://app.acme.io',
    );
    expect(
      mailConfig.parse({
        ...prod,
        MAIL_APP_URL: 'http://localhost:3000',
        SMTP_ALLOW_INSECURE: 'true',
      }).appUrl,
    ).toBe('http://localhost:3000');
  });
});
