import {
  createPrincipal,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { ClsServiceManager } from 'nestjs-cls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARGE_DRAFT, LEDGER_TEST_TENANT as TENANT_A } from '../../../test/ledger-fixtures.js';
import type { LedgerEntryDraft } from '../../domain/ledger/ledger.types.js';
import { DisabledLedger } from '../../infrastructure/ledger/disabled-ledger.js';
import { InMemoryLedger } from '../../testing/in-memory-ledger.js';
import { LedgerService } from './ledger.service.js';

const TENANT_B = '0192f0c1-0000-7000-8000-000000000002';
const USER_A1 = '0192f0c1-0000-7000-8000-00000000a001';
const principalA = createPrincipal({ userId: USER_A1, tenantId: TENANT_A, roles: [] });

const draftOf = (tenantId: string, sourceKey = `stripe:txn:txn_${tenantId.slice(-4)}`) =>
  ({
    ...CHARGE_DRAFT,
    sourceKey,
    tenantId,
    lines: CHARGE_DRAFT.lines.map((line) =>
      line.account === 'revenue:checkout' ? { ...line, accountOwnerTenantId: tenantId } : line,
    ),
  }) satisfies LedgerEntryDraft;

/** Outside any CLS context: neither a principal nor SystemContext. */
const inBareCls = <T>(fn: () => Promise<T>): Promise<T> =>
  ClsServiceManager.getClsService().run(fn);

describe('LedgerService (the ledger tenant rule)', () => {
  let ledger: InMemoryLedger;
  let service: LedgerService;
  let post: ReturnType<typeof vi.spyOn>;
  let getEntry: ReturnType<typeof vi.spyOn>;
  let balances: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    service = new LedgerService(ledger);
    post = vi.spyOn(ledger, 'post');
    getEntry = vi.spyOn(ledger, 'getEntry');
    balances = vi.spyOn(ledger, 'balances');
  });

  it('principal A posts a draft of A', async () => {
    const outcome = await runWithPrincipal(principalA, () => service.post(draftOf(TENANT_A)));

    expect(outcome.status).toBe('posted');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['tenant B', TENANT_B],
    ['the platform', PLATFORM_TENANT_ID],
  ])(
    'principal A with a draft of %s → LEDGER_TENANT_MISMATCH, the port is never called',
    async (_label, tenantId) => {
      await expect(
        runWithPrincipal(principalA, () => service.post(draftOf(tenantId))),
      ).rejects.toMatchObject({ code: 'LEDGER_TENANT_MISMATCH', httpStatus: 403 });
      expect(post).not.toHaveBeenCalled();
    },
  );

  it('a user-scoped principal (no tenant) is refused', async () => {
    const userOnly = createPrincipal({ userId: USER_A1, tenantId: null });

    await expect(
      runWithPrincipal(userOnly, () => service.post(draftOf(TENANT_A))),
    ).rejects.toMatchObject({ code: 'LEDGER_TENANT_MISMATCH' });
    expect(post).not.toHaveBeenCalled();
  });

  it('SystemContext posts platform and tenant drafts', async () => {
    const outcomes = await SystemContext.run('billing.ledger-posting', async () => [
      await service.post(draftOf(PLATFORM_TENANT_ID)),
      await service.post(draftOf(TENANT_B)),
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(['posted', 'posted']);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('no principal and no SystemContext → refused', async () => {
    await expect(service.post(draftOf(TENANT_A))).rejects.toMatchObject({
      code: 'LEDGER_TENANT_MISMATCH',
    });
    await expect(inBareCls(() => service.post(draftOf(TENANT_A)))).rejects.toMatchObject({
      code: 'LEDGER_TENANT_MISMATCH',
    });
    await expect(inBareCls(() => service.balances())).rejects.toMatchObject({
      code: 'LEDGER_TENANT_MISMATCH',
    });
    await expect(inBareCls(() => service.getEntry('e'))).rejects.toMatchObject({
      code: 'LEDGER_TENANT_MISMATCH',
    });
    expect(post).not.toHaveBeenCalled();
    expect(getEntry).not.toHaveBeenCalled();
    expect(balances).not.toHaveBeenCalled();
  });

  it('a principal nested inside SystemContext is judged as a principal', async () => {
    await expect(
      SystemContext.run('billing.ledger-posting', () =>
        runWithPrincipal(principalA, () => service.post(draftOf(PLATFORM_TENANT_ID))),
      ),
    ).rejects.toMatchObject({ code: 'LEDGER_TENANT_MISMATCH' });
    await expect(
      SystemContext.run('billing.ledger-posting', () =>
        runWithPrincipal(principalA, () => service.post(draftOf(TENANT_B))),
      ),
    ).rejects.toMatchObject({ code: 'LEDGER_TENANT_MISMATCH' });
    const outcome = await SystemContext.run('billing.ledger-posting', () =>
      runWithPrincipal(principalA, () => service.post(draftOf(TENANT_A))),
    );
    expect(outcome.status).toBe('posted');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("getEntry and balances use the principal's tenant and take none from the caller", async () => {
    const posted = await runWithPrincipal(principalA, () => service.post(draftOf(TENANT_A)));

    const entry = await runWithPrincipal(principalA, () => service.getEntry(posted.entryId));
    const sums = await runWithPrincipal(principalA, () => service.balances('usd'));
    const all = await runWithPrincipal(principalA, () => service.balances());

    expect(entry?.tenantId).toBe(TENANT_A);
    expect(getEntry).toHaveBeenCalledWith(TENANT_A, posted.entryId);
    expect(balances).toHaveBeenNthCalledWith(1, TENANT_A, 'usd');
    expect(balances).toHaveBeenNthCalledWith(2, TENANT_A, undefined);
    expect(sums.find((b) => b.account === 'revenue:checkout')).toMatchObject({ credit: 2_500n });
    expect(all).toEqual(sums);
  });

  it("another tenant's principal cannot see A's entry", async () => {
    const posted = await runWithPrincipal(principalA, () => service.post(draftOf(TENANT_A)));
    const principalB = createPrincipal({ userId: USER_A1, tenantId: TENANT_B, roles: [] });

    await expect(
      runWithPrincipal(principalB, () => service.getEntry(posted.entryId)),
    ).resolves.toBeNull();
    expect(getEntry).toHaveBeenLastCalledWith(TENANT_B, posted.entryId);
  });

  it("SystemContext reads the platform tenant's entries and balances", async () => {
    const posted = await SystemContext.run('billing.ledger-posting', () =>
      service.post(draftOf(PLATFORM_TENANT_ID)),
    );

    const entry = await SystemContext.run('billing.ledger-posting', () =>
      service.getEntry(posted.entryId),
    );
    await SystemContext.run('billing.ledger-posting', () => service.balances('usd'));

    expect(entry?.tenantId).toBe(PLATFORM_TENANT_ID);
    expect(getEntry).toHaveBeenCalledWith(PLATFORM_TENANT_ID, posted.entryId);
    expect(balances).toHaveBeenCalledWith(PLATFORM_TENANT_ID, 'usd');
  });

  it('disabled → LEDGER_DISABLED (503) for every call', async () => {
    const disabled = new LedgerService(new DisabledLedger());

    await expect(
      runWithPrincipal(principalA, () => disabled.post(draftOf(TENANT_A))),
    ).rejects.toMatchObject({ code: 'LEDGER_DISABLED', httpStatus: 503 });
    await expect(runWithPrincipal(principalA, () => disabled.getEntry('e'))).rejects.toMatchObject({
      code: 'LEDGER_DISABLED',
    });
    await expect(
      SystemContext.run('billing.ledger-posting', () => disabled.balances()),
    ).rejects.toMatchObject({ code: 'LEDGER_DISABLED' });
  });
});
