import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Audit fixes (2026-11-23): the docs say what the code does. Each describe block belongs to one
 * audit finding, so a doc that drifts back fails here with the finding named.
 */
const root = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

/** The text of one `##`/`###` section: from its heading to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`no section "${heading}"`);
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const length = lines
    .slice(start + 1)
    .findIndex((line) => new RegExp(`^#{1,${level}} `).test(line) && !line.startsWith('```'));
  return lines.slice(start, length === -1 ? undefined : start + 1 + length).join('\n');
}

/** Collapses line wraps, so a phrase matches wherever prettier broke the line. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('OPS-4: SHUTDOWN_DRAIN_MS is documented where an operator looks', () => {
  it.each(['docs/CONFIGURATION.md', 'docs/OBSERVABILITY.md', 'docs/SECURITY.md', '.env.example'])(
    '%s names it',
    (file) => {
      expect(read(file)).toContain('SHUTDOWN_DRAIN_MS');
    },
  );

  it('the observability doc no longer says that no app sets a drain', () => {
    expect(flat(read('docs/OBSERVABILITY.md'))).not.toContain('No app sets');
  });

  it('the production checklist ties the drain to the shutdown timeout', () => {
    const checklist = flat(read('docs/SECURITY.md'));
    expect(checklist).toMatch(/- \[ \] `SHUTDOWN_DRAIN_MS`[^-]*`SHUTDOWN_TIMEOUT_MS`/);
  });
});

describe('config-ref-pre-ledger-wiring: nothing says the ledger or the outbox is unwired', () => {
  it('the immudb namespace is described as loaded by the monolith and billing-service', () => {
    const immudb = flat(
      section(read('docs/CONFIGURATION.md'), '### `immudb` — append-only verifiable SQL store'),
    );
    expect(immudb).not.toContain('not loaded by any app yet');
    expect(immudb).toContain('monolith and billing-service');
    expect(immudb).toContain('LEDGER_ENABLED=true');
  });

  it('billing-service is documented as pinning its consumer group, not as only producing', () => {
    const kafka = flat(read('docs/CONFIGURATION.md'));
    expect(kafka).not.toContain('identity-service and billing-service only produce');
    expect(kafka).toContain('BILLING_CONSUMER_GROUP');
  });

  it('.env.example does not call a loaded namespace unloaded', () => {
    expect(read('.env.example')).not.toContain('not loaded by any app yet');
  });
});
