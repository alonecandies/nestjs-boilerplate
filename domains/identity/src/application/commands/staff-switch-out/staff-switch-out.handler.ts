import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { AccessTokenDenylist } from '@platform/auth';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { StaffSwitchOutCommand } from './staff-switch-out.command.js';

/**
 * Revokes a staff switch-in token before its expiry (Redis denylist, like logout) and writes the
 * `staff.switch_out` row next to the `staff.switch_in` one. The edge guarantees a switch-in token
 * (`@StaffOnly()`); the RPC trusts its caller.
 */
@CommandHandler(StaffSwitchOutCommand)
export class StaffSwitchOutHandler implements ICommandHandler<StaffSwitchOutCommand> {
  constructor(
    private readonly denylist: AccessTokenDenylist,
    private readonly audit: TenantAuditLog,
  ) {}

  async execute(command: StaffSwitchOutCommand): Promise<void> {
    await this.denylist.deny(command.accessToken.jti, command.accessToken.exp);
    await this.audit.record({
      tenantId: command.tenantId,
      actorId: command.staffUserId,
      type: AUDIT_EVENT_TYPES.STAFF_SWITCH_OUT,
      data: { accessTokenJti: command.accessToken.jti },
    });
  }
}
