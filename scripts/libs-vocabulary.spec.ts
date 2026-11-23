import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const LIBS = join(ROOT, 'libs');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'generated']);
/** Spec files, and everything under a test/ or testing/ folder (fixtures, doubles). */
const TEST_FILE = /(?:^|\/)(?:test|testing)\/.+\.ts$|\.(?:spec|int-spec|e2e-spec)\.ts$/;

/** Paths exempt from the check (none: B2-20 removed the libs/auth exemption with the Permission enum). */
const EXEMPT_PREFIXES: readonly string[] = [];
/** A line may name a domain only to assert that libs do NOT contain it. */
const ALLOW_MARKER = 'vocabulary-allow';

/** Domain folder names that are also generic words: only their package spellings count. */
const GENERIC_DOMAIN_NAMES = new Set([
  'files',
  // `ai` is also the platform capability (@platform/ai, the AI SDK package `ai`).
  'ai',
]);

/**
 * Words that name a business domain of this repo: every domains/<x> folder name (the generic ones
 * by their package spellings only) plus billing's vocabulary. Specs use the neutral example
 * vocabulary instead: orders, catalog, alerts, shipments.
 */
const DOMAIN_WORDS: readonly string[] = [
  ...readdirSync(join(ROOT, 'domains'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !GENERIC_DOMAIN_NAMES.has(entry.name))
    .map((entry) => entry.name),
  'notification',
  'payment',
  'payments',
  'stripe',
  'checkout',
  'files-service',
  '@domain/files',
  'ai-service',
  '@domain/ai',
];
const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** A domain word between non-alphanumerics: `_`, `-`, `.` and camelCase humps are boundaries. */
const DOMAIN_WORD = new RegExp(
  `(?<![a-z0-9])(?:${DOMAIN_WORDS.map(escapeRegExp).join('|')})(?![a-z0-9])`,
  'i',
);
/** `paymentId` → `payment Id`, `FixturePaymentSucceeded` → `Fixture Payment Succeeded`. */
const splitCamelCase = (line: string): string => line.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
const namesDomain = (line: string): boolean => DOMAIN_WORD.test(splitCamelCase(line));

const posixPath = (path: string): string => relative(ROOT, path).split(sep).join('/');

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* testFiles(path);
    else if (TEST_FILE.test(posixPath(path))) yield path;
  }
}

/** Non-test `.ts` sources: what ships, as opposed to specs and fixtures. */
function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith('.ts') && !TEST_FILE.test(posixPath(path))) yield path;
  }
}

describe('libs vocabulary: libs/ names no domain, specs and fixtures included', () => {
  it('derives the domain words from domains/*', () => {
    expect(DOMAIN_WORDS).toEqual(expect.arrayContaining(['billing', 'identity', 'notifications']));
  });

  it('flags domain words, also inside identifiers, and leaves the neutral vocabulary alone', () => {
    expect(namesDomain("SERVICE_NAME: 'identity-service'")).toBe(true);
    expect(namesDomain("'billing:checkout'")).toBe(true);
    expect(namesDomain("defineEventContract('fixture.payment-succeeded.v1', x)")).toBe(true);
    expect(namesDomain('FIXTURE_PAYMENT_SUCCEEDED_EVENT')).toBe(true);
    expect(namesDomain('const payload = { paymentId: generateId() };')).toBe(true);
    expect(namesDomain('fixturePaymentSucceededPayload')).toBe(true);
    expect(namesDomain('SELECT id FROM notifications_by_user')).toBe(true);
    expect(namesDomain("SERVICE_NAME: 'orders-service'")).toBe(false);
    expect(namesDomain('const shipmentId = orderPlaced.id;')).toBe(false);
    expect(namesDomain('copies the migration files')).toBe(false);
    expect(namesDomain("import { generateText } from 'ai';")).toBe(false);
    expect(namesDomain("import { ConversationsRepository } from '@domain/ai';")).toBe(true);
    expect(namesDomain("SERVICE_NAME: 'ai-service'")).toBe(true);
  });

  it('finds no domain word outside the exempt paths', () => {
    const files = [...testFiles(LIBS)];
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const file of files) {
      const path = relative(ROOT, file).split(sep).join('/');
      if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!line.includes(ALLOW_MARKER) && namesDomain(line)) {
            hits.push(`${path}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it('libs/config sources name no domain either (a removed variable is checked by its domain)', () => {
    const files = [...sourceFiles(join(LIBS, 'config', 'src'))];
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!line.includes(ALLOW_MARKER) && namesDomain(line)) {
            hits.push(`${posixPath(file)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});
