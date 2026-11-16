import { Logger } from '@nestjs/common';
import { isUuidV7 } from '@platform/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_EVENT_TYPES,
  type AuditEventsRepository,
  type NewAuditEvent,
} from '../persistence/audit-events.repository.js';
import { TenantAuditLog } from './tenant-audit-log.service.js';

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';
const ACTOR = '0190f3b2-0000-7000-8000-000000000001';

describe('TenantAuditLog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('appends one row in the target tenant and writes the audit log line (AUDIT-F16)', async () => {
    const appended: NewAuditEvent[] = [];
    const repository = {
      append: vi.fn(async (event: NewAuditEvent) => {
        appended.push(event);
      }),
      listForTenant: vi.fn(),
    } as unknown as AuditEventsRepository;
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const now = new Date('2026-11-09T10:00:00Z');

    const id = await new TenantAuditLog(repository).record({
      tenantId: TENANT,
      actorId: ACTOR,
      type: AUDIT_EVENT_TYPES.STAFF_SWITCH_IN,
      data: { reason: 'ticket 42' },
      now,
    });

    expect(isUuidV7(id)).toBe(true);
    expect(appended).toEqual([
      {
        tenantId: TENANT,
        id,
        actorId: ACTOR,
        type: 'staff.switch_in',
        data: { reason: 'ticket 42' },
        createdAt: now,
      },
    ]);
    expect(log).toHaveBeenCalledWith(
      {
        audit: 'staff.switch_in',
        auditEventId: id,
        tenantId: TENANT,
        actorId: ACTOR,
        data: { reason: 'ticket 42' },
      },
      'Audit event recorded',
    );
  });

  it('defaults data to {} and a missing actor to null; a failing append writes no log line', async () => {
    const repository = {
      append: vi.fn(async () => {
        throw new Error('db down');
      }),
      listForTenant: vi.fn(),
    } as unknown as AuditEventsRepository;
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await expect(
      new TenantAuditLog(repository).record({
        tenantId: TENANT,
        actorId: null,
        type: AUDIT_EVENT_TYPES.MEMBER_LEFT,
      }),
    ).rejects.toThrow('db down');
    expect(repository.append).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: null, data: {}, type: 'member.left' }),
    );
    expect(log).not.toHaveBeenCalled();
  });
});
