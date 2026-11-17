import { describe, expect, it, vi } from 'vitest';
import { runStaffGrantCli, type StaffGrantDeps, type StaffStore } from './staff-grant.js';

const ID = '0190f3b2-0000-7000-8000-000000000001';

function harness(env: Record<string, string | undefined>, found: string | null = ID) {
  const out: string[] = [];
  const err: string[] = [];
  const store: StaffStore = {
    setPlatformStaff: vi.fn(async () => found),
    close: vi.fn(async () => undefined),
  };
  const connect = vi.fn((_url: string) => store);
  const deps: StaffGrantDeps = {
    env,
    connect,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, store, connect, out, err };
}

describe('staff:grant', () => {
  it('grants the flag to the normalised email over DATABASE_MIGRATION_URL and exits 0', async () => {
    const h = harness({
      DATABASE_URL: 'postgres://app@db/app',
      DATABASE_MIGRATION_URL: 'postgres://owner@db/app',
    });
    await expect(runStaffGrantCli(['  Ada@Example.COM '], h.deps)).resolves.toBe(0);
    expect(h.connect).toHaveBeenCalledWith('postgres://owner@db/app');
    expect(h.store.setPlatformStaff).toHaveBeenCalledWith('ada@example.com', true);
    expect(h.out).toEqual([`Granted platform staff to ada@example.com (${ID}).`]);
    expect(h.store.close).toHaveBeenCalled();
  });

  it('--revoke clears the flag', async () => {
    const h = harness({ DATABASE_MIGRATION_URL: 'postgres://owner@db/app' });
    await expect(runStaffGrantCli(['ada@example.com', '--revoke'], h.deps)).resolves.toBe(0);
    expect(h.connect).toHaveBeenCalledWith('postgres://owner@db/app');
    expect(h.store.setPlatformStaff).toHaveBeenCalledWith('ada@example.com', false);
    expect(h.out).toEqual([`Revoked platform staff from ada@example.com (${ID}).`]);
  });

  it('exit 1 for an unknown email; the connection is still closed', async () => {
    const h = harness({ DATABASE_MIGRATION_URL: 'postgres://owner@db/app' }, null);
    await expect(runStaffGrantCli(['nobody@example.com'], h.deps)).resolves.toBe(1);
    expect(h.err).toEqual(['No user with email nobody@example.com.']);
    expect(h.store.close).toHaveBeenCalled();
  });

  it.each([
    [[], /Usage: staff:grant <email> \[--revoke\]/],
    [['not-an-email'], /Usage/],
    [['a@b.c', 'd@e.f'], /Usage/],
    [['a@b.c', '--force'], /Usage/],
  ])('exit 2 for arguments %j, nothing connected', async (args, message) => {
    const h = harness({ DATABASE_MIGRATION_URL: 'postgres://owner@db/app' });
    await expect(runStaffGrantCli(args, h.deps)).resolves.toBe(2);
    expect(h.err.join('\n')).toMatch(message);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it.each([{}, { DATABASE_URL: 'postgres://app@db/app' }, { DATABASE_MIGRATION_URL: '' }])(
    'exit 2 without DATABASE_MIGRATION_URL (never DATABASE_URL), nothing connected: %j',
    async (env) => {
      const h = harness(env);
      await expect(runStaffGrantCli(['ada@example.com'], h.deps)).resolves.toBe(2);
      expect(h.err).toEqual([
        'Set DATABASE_MIGRATION_URL (the app_owner role, direct to the coordinator).',
      ]);
      expect(h.connect).not.toHaveBeenCalled();
    },
  );

  it('exit 1 and the error message (never the URL) when the database fails', async () => {
    const h = harness({ DATABASE_MIGRATION_URL: 'postgres://owner:secret@db/app' });
    vi.mocked(h.store.setPlatformStaff).mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(runStaffGrantCli(['ada@example.com'], h.deps)).resolves.toBe(1);
    expect(h.err).toEqual(['staff:grant failed: connect ECONNREFUSED']);
    expect(h.err.join('\n')).not.toContain('secret');
    expect(h.store.close).toHaveBeenCalled();
  });
});
