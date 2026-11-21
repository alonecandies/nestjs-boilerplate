import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const api = readFileSync(join(root, 'docs/API.md'), 'utf8');
const codesIn = (file: string, object: string): string[] => {
  const source = readFileSync(join(root, file), 'utf8');
  const block =
    new RegExp(`export const ${object} = \\{([\\s\\S]*?)\\} as const`).exec(source)?.[1] ?? '';
  return [...block.matchAll(/:\s*'([A-Z_]+)'/g)].map((m) => m[1] ?? '');
};

describe('docs/API.md error catalogue (F23)', () => {
  it.each([
    ['domains/identity/src/identity.constants.ts', 'IdentityErrorCode'],
    ['domains/billing/src/billing.constants.ts', 'BillingErrorCode'],
    ['libs/ai/src/ai.errors.ts', 'AiErrorCode'],
    ['domains/ai/src/ai.constants.ts', 'AiChatErrorCode'],
  ])('lists every code of %s', (file, object) => {
    const codes = codesIn(file, object);
    expect(codes.length).toBeGreaterThan(0);
    const missing = codes.filter((code) => !api.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });

  it('lists the storage codes and the 408 mapping', () => {
    for (const code of ['STORAGE_ERROR', 'INVALID_STORAGE_KEY'])
      expect(api).toContain(`\`${code}\``);
    expect(api).toMatch(/408[^\n]*TIMEOUT|TIMEOUT[^\n]*408/);
  });
});
