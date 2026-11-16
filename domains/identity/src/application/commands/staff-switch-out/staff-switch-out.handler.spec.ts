import type { AccessTokenDenylist } from '@platform/auth';
import { describe, expect, it } from 'vitest';
import { mockOf } from '../../../../test/mocks.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import type { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { StaffSwitchOutCommand } from './staff-switch-out.command.js';
import { StaffSwitchOutHandler } from './staff-switch-out.handler.js';

describe('StaffSwitchOutHandler', () => {
  it('denylists the switch-in token, then records staff.switch_out in the tenant', async () => {
    const log: string[] = [];
    const denylist = mockOf<AccessTokenDenylist>({
      deny: async () => {
        log.push('deny');
      },
    });
    const audit = mockOf<TenantAuditLog>({
      record: async () => {
        log.push('audit');
        return 'audit-2';
      },
    });
    const handler = new StaffSwitchOutHandler(denylist, audit);
    const tenantId = '0190f3b2-0000-7000-8000-0000000000aa';
    const staffUserId = '0190f3b2-0000-7000-8000-000000000001';

    await handler.execute(
      new StaffSwitchOutCommand(staffUserId, tenantId, { jti: 'staff-jti', exp: 1_900_000_000 }),
    );

    expect(denylist.deny).toHaveBeenCalledWith('staff-jti', 1_900_000_000);
    expect(audit.record).toHaveBeenCalledWith({
      tenantId,
      actorId: staffUserId,
      type: AUDIT_EVENT_TYPES.STAFF_SWITCH_OUT,
      data: { accessTokenJti: 'staff-jti' },
    });
    expect(log).toEqual(['deny', 'audit']);
  });
});
