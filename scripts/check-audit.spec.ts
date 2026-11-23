import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * CI-1 (audit 2026-11-23): the advisory gate fails on a high or critical production advisory
 * unless a dated entry of .github/audit-ignore.json covers it, and an expired entry fails too, as
 * does an entry that expires more than 90 days ahead (so each one is revisited within 90 days).
 * Every case feeds a saved report (--input) and a fixed date (--today): no network, no wall clock.
 */
const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(import.meta.dirname, 'check-audit.mjs');
const TODAY = '2026-11-24';

const HIGH = {
  id: 1_116_225,
  url: 'https://github.com/advisories/GHSA-4992-7rv2-5pvq',
  title: 'undici: unbounded decompression chain',
  severity: 'high',
  vulnerable_versions: '>=7.0.0 <7.24.0',
};
const MODERATE = {
  id: 1_244_623,
  url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249',
  title: 'minimatch: denial of service via globparts amplification',
  severity: 'moderate',
  vulnerable_versions: '>=7.0.0 <11.0.1',
};

const ignore = (overrides: Record<string, unknown> = {}) => ({
  id: 'GHSA-4992-7rv2-5pvq',
  package: 'undici',
  reason: 'no fixed version inside the major the SDK pins',
  expires: '2026-12-31',
  ...overrides,
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function check(
  report: unknown,
  ignores: unknown = { ignores: [] },
  ...extra: string[]
): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'check-audit-'));
  roots.push(root);
  const input = join(root, 'audit.json');
  const ignoreFile = join(root, 'audit-ignore.json');
  writeFileSync(input, typeof report === 'string' ? report : JSON.stringify(report));
  writeFileSync(ignoreFile, JSON.stringify(ignores));
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--input', input, '--ignores', ignoreFile, '--today', TODAY, ...extra],
    { encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('scripts/check-audit.mjs', () => {
  it('fails on a high advisory and names it', () => {
    const result = check({ undici: [HIGH] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('GHSA-4992-7rv2-5pvq');
    expect(result.output).toContain('undici');
  });

  it('fails on a critical advisory', () => {
    const result = check({ 'form-data': [{ ...HIGH, severity: 'critical' }] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('CRITICAL');
  });

  it('passes the same high advisory while an unexpired ignore covers it', () => {
    const result = check({ undici: [HIGH] }, { ignores: [ignore()] });
    expect(result.output).toContain('ignored');
    expect(result.status).toBe(0);
  });

  it('accepts bun’s numeric advisory id in an ignore entry', () => {
    const result = check({ undici: [HIGH] }, { ignores: [ignore({ id: String(HIGH.id) })] });
    expect(result.status).toBe(0);
  });

  it('keeps an ignore valid through its expiry day', () => {
    const result = check({ undici: [HIGH] }, { ignores: [ignore({ expires: TODAY })] });
    expect(result.status).toBe(0);
  });

  it('fails when the ignore has expired, naming the entry', () => {
    const result = check({ undici: [HIGH] }, { ignores: [ignore({ expires: '2026-11-23' })] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('expired on 2026-11-23');
    expect(result.output).toContain('GHSA-4992-7rv2-5pvq');
  });

  it('fails on an expired ignore even when the advisory is gone', () => {
    const result = check({}, { ignores: [ignore({ expires: '2026-01-01' })] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('expired on 2026-01-01');
  });

  it('does not let an ignore of another package cover the advisory', () => {
    const result = check({ undici: [HIGH] }, { ignores: [ignore({ package: 'axios' })] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('GHSA-4992-7rv2-5pvq');
  });

  it('fails on an ignore that expires more than 90 days after today, naming the entry', () => {
    // 2026-11-24 + 91 days = 2027-02-23.
    const result = check({ undici: [HIGH] }, { ignores: [ignore({ expires: '2027-02-23' })] });
    expect(result.status).toBe(1);
    expect(result.output).toContain('GHSA-4992-7rv2-5pvq');
    expect(result.output).toContain('more than 90 days');
    // Even with no advisory left to cover: the horizon is about the entry, not the report.
    expect(check({}, { ignores: [ignore({ expires: '2030-01-01' })] }).status).toBe(1);
  });

  it('accepts an ignore that expires within 90 days of today', () => {
    // 2026-11-24 + 89 days = 2027-02-21; + 90 days = 2027-02-22 (the last day accepted).
    for (const expires of ['2027-02-21', '2027-02-22']) {
      const result = check({ undici: [HIGH] }, { ignores: [ignore({ expires })] });
      expect(result.status, expires).toBe(0);
    }
  });

  it('fails on a malformed ignore entry (no reason, impossible date)', () => {
    expect(check({}, { ignores: [ignore({ reason: '' })] }).output).toContain('lacks reason');
    const badDate = check({}, { ignores: [ignore({ expires: '2026-02-30' })] });
    expect(badDate.status).toBe(1);
    expect(badDate.output).toContain('not a YYYY-MM-DD date');
  });

  it('lists moderate and low advisories without failing', () => {
    const result = check({ minimatch: [MODERATE], glob: [{ ...MODERATE, severity: 'low' }] });
    expect(result.status).toBe(0);
    expect(result.output).toContain('GHSA-g3hv-75wg-m249');
    expect(result.output).toContain('not blocking');
  });

  it('fails closed on a report that is not JSON (registry error text)', () => {
    const result = check('error: POST https://registry.npmjs.org/... - ProxyConnectFailed');
    expect(result.status).toBe(1);
    expect(result.output).toContain('not JSON');
  });

  it('rejects a usage error with exit 2', () => {
    expect(check({}, { ignores: [] }, '--today', 'tomorrow').status).toBe(2);
  });

  it('accepts the repository’s own ignore file', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-audit-'));
    roots.push(root);
    writeFileSync(join(root, 'audit.json'), '{}');
    // The earliest expiry of the file (each entry is valid through its expiry day, and every
    // entry expires within 90 days of the day it is checked): this checks the file's shape, not
    // the calendar.
    const { ignores } = JSON.parse(
      readFileSync(join(ROOT, '.github', 'audit-ignore.json'), 'utf8'),
    ) as { ignores: { expires: string }[] };
    const today = ignores.map((entry) => entry.expires).sort()[0] ?? TODAY;
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--input', join(root, 'audit.json'), '--today', today],
      { encoding: 'utf8', cwd: ROOT },
    );
    expect(`${result.stdout}${result.stderr}`).toContain('no high or critical');
    expect(result.status).toBe(0);
  });
});
