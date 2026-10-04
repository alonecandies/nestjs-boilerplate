import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Handlebars from 'handlebars';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAIL_TEMPLATE_HELPERS } from './mail-template.helpers.js';
import { MAIL_PARTIALS_DIR, MAIL_TEMPLATES, MAIL_TEMPLATES_DIR } from './mailer.constants.js';

/**
 * Compiles the .hbs files with an isolated Handlebars environment, using the same compile options
 * (strict), helpers and partial names as the mailer's HandlebarsAdapter.
 */
function createRenderer(): (template: string, context: Record<string, unknown>) => string {
  const hbs = Handlebars.create();
  hbs.registerHelper(MAIL_TEMPLATE_HELPERS);
  for (const file of readdirSync(MAIL_PARTIALS_DIR)) {
    const source = readFileSync(join(MAIL_PARTIALS_DIR, file), 'utf8');
    hbs.registerPartial(basename(file, '.hbs'), hbs.compile(source, { strict: true }));
  }
  const compiled = new Map<string, Handlebars.TemplateDelegate>();
  return (template, context) => {
    let fn = compiled.get(template);
    if (fn === undefined) {
      fn = hbs.compile(readFileSync(join(MAIL_TEMPLATES_DIR, `${template}.hbs`), 'utf8'), {
        strict: true,
      });
      compiled.set(template, fn);
    }
    return fn(context);
  };
}

const base = { appName: 'Acme', year: 2026 };

describe('mail templates', () => {
  let render: ReturnType<typeof createRenderer>;

  beforeAll(() => {
    render = createRenderer();
  });

  it('ships exactly the declared templates', () => {
    const files = readdirSync(MAIL_TEMPLATES_DIR)
      .filter((f) => f.endsWith('.hbs'))
      .map((f) => basename(f, '.hbs'))
      .sort();

    expect(files).toEqual([...MAIL_TEMPLATES].sort());
  });

  it.each(MAIL_TEMPLATES)('%s renders a complete HTML document with header and footer', (name) => {
    const html = render(name, {
      ...base,
      displayName: 'Jane',
      paymentId: 'pay_1',
      amount: '$19.99',
      paidAt: '2026-09-29',
      unreadCount: 0,
      items: [],
    });

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('</html>');
    expect(html).toContain('&copy; 2026 Acme');
  });

  it('welcome: greets the user and escapes HTML in variables', () => {
    const html = render('welcome', { ...base, displayName: '<script>alert(1)</script>' });

    expect(html).toContain('Welcome, &lt;script&gt;alert(1)&lt;/script&gt;!');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<title>Welcome to Acme</title>');
    expect(html).not.toContain('Open the app'); // no appUrl → no button
  });

  it('welcome: renders the call-to-action partial when appUrl is set', () => {
    const html = render('welcome', { ...base, displayName: 'Jane', appUrl: 'https://app.test' });

    expect(html).toContain('href="https://app.test"');
    expect(html).toContain('Open the app');
  });

  it('payment-receipt: shows amount, reference and the optional description', () => {
    const html = render('payment-receipt', {
      ...base,
      paymentId: 'pay_123',
      amount: '€42.00',
      paidAt: '2026-09-29 10:00 UTC',
      description: 'Pro plan × 2',
    });

    expect(html).toContain('We received your payment of €42.00.');
    expect(html).toContain('pay_123');
    expect(html).toContain('Pro plan × 2');
    expect(html).toContain('Thanks for your payment'); // no displayName
  });

  it('daily-digest: lists items and pluralizes', () => {
    const items = [
      { title: 'Payment received', body: '$19.99', createdAt: '09:00' },
      { title: 'Welcome', body: 'Hello!', createdAt: '08:00' },
    ];

    const many = render('daily-digest', { ...base, displayName: 'Jane', unreadCount: 2, items });
    const one = render('daily-digest', { ...base, unreadCount: 1, items: items.slice(0, 1) });
    const none = render('daily-digest', { ...base, unreadCount: 0, items: [] });

    expect(many).toContain('Jane, here is your daily digest');
    expect(many).toContain('unread notifications.');
    expect(many.match(/Payment received|Welcome</g)).toHaveLength(2);
    expect(one).toContain('unread notification.');
    expect(none).toContain('Nothing new since yesterday.');
  });

  it('strict mode: a missing required variable throws instead of rendering blank', () => {
    expect(() => render('welcome', base)).toThrow(/"displayName" not defined/);
    expect(() =>
      render('daily-digest', { ...base, unreadCount: 1, items: [{ title: 'x', body: 'y' }] }),
    ).toThrow(/"createdAt" not defined/);
  });
});
