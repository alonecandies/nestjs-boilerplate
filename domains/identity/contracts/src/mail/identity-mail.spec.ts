import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDENTITY_MAIL_TEMPLATES, IDENTITY_MAIL_TEMPLATES_DIR } from './identity-mail.js';

describe('identity mail templates', () => {
  const file = join(
    IDENTITY_MAIL_TEMPLATES_DIR,
    `${IDENTITY_MAIL_TEMPLATES.TENANT_INVITATION}.hbs`,
  );

  it('ships the invitation template next to the module', () => {
    expect(existsSync(file)).toBe(true);
  });

  it('uses only the variables of TenantInvitationMailContext plus the layout ones', () => {
    const used = new Set(
      [...readFileSync(file, 'utf8').matchAll(/\{\{[#/]?(?:if )?([a-zA-Z]+)/g)].map((m) => m[1]),
    );
    for (const name of used) {
      expect([
        'tenantName',
        'inviterName',
        'roles',
        'token',
        'acceptUrl',
        'expiresAt',
        'appName',
        'if',
      ]).toContain(name);
    }
  });
});
