import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JwtService } from '@nestjs/jwt';
import { authConfig } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { refreshTokenConfig } from './refresh-token.config.js';
import { TokenIssuer } from './token-issuer.service.js';

/**
 * AUDIT-F26: docs/SECURITY.md must name every claim identity actually issues, and must not present
 * code constants as environment variables.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const security = readFileSync(join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
const configuration = readFileSync(join(ROOT, 'docs', 'CONFIGURATION.md'), 'utf8');
const tableRow = (label: string): string => {
  const row = security.split('\n').find((line) => line.startsWith(`| ${label} `));
  if (row === undefined) throw new Error(`SECURITY.md has no token row "${label}"`);
  return row;
};

const jwt = new JwtService();
const issuer = new TokenIssuer(
  jwt,
  authConfig.parse({ NODE_ENV: 'test' }),
  refreshTokenConfig.parse({ NODE_ENV: 'test' }),
);
const subject = {
  id: '0190f3b2-0000-7000-8000-000000000001',
  email: 'a@b.c',
  tenantId: '0190f3b2-0000-7000-8000-0000000000aa',
  roles: ['admin'] as const,
  staff: true,
};

describe('docs/SECURITY.md token table (AUDIT-F26)', () => {
  it('the Access row names every claim of an access token (a staff one: the largest claim set)', async () => {
    const claims = jwt.decode<Record<string, unknown>>(
      (await issuer.issueAccessToken(subject)).token,
    );
    const row = tableRow('Access');
    for (const claim of Object.keys(claims)) expect(row, claim).toContain(`\`${claim}\``);
  });

  it('the Refresh row names every claim of a refresh token', async () => {
    const issued = await issuer.issueRefreshToken({
      userId: subject.id,
      sessionId: '0190f3b2-0000-7000-8000-000000000002',
    });
    const row = tableRow('Refresh');
    for (const claim of Object.keys(jwt.decode<Record<string, unknown>>(issued.token))) {
      expect(row, claim).toContain(`\`${claim}\``);
    }
  });

  it.each(['JWT_CLOCK_TOLERANCE_SEC', 'STRIPE_WEBHOOK_TOLERANCE_SEC'])(
    '%s is a code constant: never in .env.example or CONFIGURATION.md, and called a constant in SECURITY.md',
    (name) => {
      expect(envExample).not.toContain(name);
      expect(configuration).not.toContain(name);
      const mentions = security.split('\n').filter((line) => line.includes(name));
      expect(mentions.length).toBeGreaterThan(0);
      for (const line of mentions) expect(line).toMatch(/code constant/);
    },
  );
});
