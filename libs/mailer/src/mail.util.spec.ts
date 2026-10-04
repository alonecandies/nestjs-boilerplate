import { describe, expect, it } from 'vitest';
import { isPermanentMailError } from './mail.errors.js';
import {
  defaultMailContext,
  defineMail,
  formatMoney,
  mailFromName,
  toMailJobId,
} from './mail.util.js';

describe('toMailJobId', () => {
  it('keeps safe keys verbatim', () => {
    expect(toMailJobId('welcome-0199a3c1-7b2e')).toBe('welcome-0199a3c1-7b2e');
    expect(toMailJobId('digest_2026.09.29')).toBe('digest_2026.09.29');
  });

  it('hashes keys BullMQ rejects or that are unusually long', () => {
    for (const key of ['a:b', '42', 'with space', 'x'.repeat(129), 'ünïcode']) {
      expect(toMailJobId(key)).toMatch(/^k-[0-9a-f]{64}$/);
    }
    expect(toMailJobId('a:b')).toBe(toMailJobId('a:b'));
    expect(toMailJobId('a:b')).not.toBe(toMailJobId('a:c'));
  });
});

describe('mailFromName / defaultMailContext', () => {
  it('extracts the display name of MAIL_FROM', () => {
    expect(mailFromName('NestJS Boilerplate <no-reply@example.com>')).toBe('NestJS Boilerplate');
    expect(mailFromName('"Acme, Inc." <a@acme.io>')).toBe('Acme, Inc.');
    expect(mailFromName('no-reply@example.com')).toBeUndefined();
    expect(mailFromName('<no-reply@example.com>')).toBeUndefined();
  });

  it('falls back to the default app name', () => {
    expect(defaultMailContext('x@y.z', new Date('2031-01-01T00:00:00Z'))).toEqual({
      appName: 'NestJS Boilerplate',
      year: 2031,
    });
  });
});

describe('formatMoney', () => {
  it('formats minor units with the currency precision', () => {
    expect(formatMoney(1999, 'usd')).toBe('$19.99');
    expect(formatMoney(500, 'JPY')).toBe('¥500');
    expect(formatMoney(1234567, 'eur', 'de-DE')).toBe('12.345,67\u00a0€'); // NBSP before €
  });
});

describe('defineMail', () => {
  it('builds a MailMessage from a typed context', () => {
    const mail = defineMail({
      to: 'a@b.c',
      subject: 'Digest',
      template: 'daily-digest',
      context: { unreadCount: 0, items: [] },
      idempotencyKey: 'digest-u1-2026-09-29',
    });

    expect(mail).toEqual({
      to: 'a@b.c',
      subject: 'Digest',
      template: 'daily-digest',
      context: { unreadCount: 0, items: [] },
      idempotencyKey: 'digest-u1-2026-09-29',
    });
  });
});

describe('isPermanentMailError', () => {
  it('classifies SMTP replies and nodemailer codes', () => {
    expect(isPermanentMailError(Object.assign(new Error('x'), { responseCode: 550 }))).toBe(true);
    expect(isPermanentMailError(Object.assign(new Error('x'), { responseCode: 421 }))).toBe(false);
    expect(isPermanentMailError(Object.assign(new Error('x'), { code: 'EENVELOPE' }))).toBe(true);
    expect(isPermanentMailError(Object.assign(new Error('x'), { code: 'ECONNECTION' }))).toBe(
      false,
    );
    expect(isPermanentMailError(new Error('socket hang up'))).toBe(false);
    expect(isPermanentMailError(undefined)).toBe(false);
  });
});
