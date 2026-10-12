import { describe, expect, expectTypeOf, it } from 'vitest';
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

/** A domain's template → context map, test-local (platform specs name no domain). */
interface FixtureMailContextMap {
  greeting: { name: string };
  reminder: { dueAt: string; items: string[] };
}

const defineFixtureMail = defineMail<FixtureMailContextMap>();

describe('defineMail', () => {
  it('builds a MailMessage from a context typed by the domain template map', () => {
    const mail = defineFixtureMail({
      to: 'a@b.c',
      subject: 'Reminder',
      template: 'reminder',
      context: { dueAt: '2026-10-12', items: [] },
      idempotencyKey: 'reminder-u1-2026-10-12',
    });

    expect(mail).toEqual({
      to: 'a@b.c',
      subject: 'Reminder',
      template: 'reminder',
      context: { dueAt: '2026-10-12', items: [] },
      idempotencyKey: 'reminder-u1-2026-10-12',
    });
    expectTypeOf(mail.template).toEqualTypeOf<'reminder'>();
  });

  it('types the context by the template it names', () => {
    expectTypeOf(defineFixtureMail<'greeting'>)
      .parameter(0)
      .toHaveProperty('context')
      .toEqualTypeOf<{ name: string }>();
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
