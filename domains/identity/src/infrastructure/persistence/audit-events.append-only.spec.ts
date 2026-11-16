import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DrizzleAuditEventsRepository } from './drizzle-audit-events.repository.js';

const SRC = join(import.meta.dirname, '..', '..');
/** Drizzle `.update(auditEvents)` / `.delete(auditEvents)`, or raw `UPDATE` / `DELETE FROM` on the table. */
const MUTATION =
  /\.(?:update|delete)\(\s*auditEvents\b|\b(?:update|delete\s+from)\s+"?identity"?\s*\.\s*"?audit_events\b/i;

/** Every non-spec TypeScript source under domains/identity/src. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !/\.(?:spec|int-spec|e2e-spec)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('identity.audit_events is append-only (code side; B3 adds the database side)', () => {
  it('the Drizzle repository only appends and lists', () => {
    const methods = Object.getOwnPropertyNames(DrizzleAuditEventsRepository.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual(['append', 'listForTenant']);
  });

  it('no identity source updates or deletes audit rows', () => {
    expect(MUTATION.test('await this.txHost.tx.delete(auditEvents).where(x)')).toBe(true);
    expect(MUTATION.test('UPDATE "identity"."audit_events" SET data = $1')).toBe(true);
    expect(MUTATION.test('await this.txHost.tx.insert(auditEvents).values(event)')).toBe(false);
    const offenders = sources(SRC)
      .filter((file) => MUTATION.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
