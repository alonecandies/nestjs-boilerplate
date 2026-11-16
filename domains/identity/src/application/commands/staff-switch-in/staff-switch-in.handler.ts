import type { StaffAccessToken } from '@domain/identity-contracts';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  DomainValidationException,
  EntityNotFoundException,
  isPlatformTenantId,
  isUuid,
} from '@platform/common';
import { NotPlatformStaffException } from '../../../domain/identity.errors.js';
import { BEARER_TOKEN_TYPE, IDENTITY_LIMITS } from '../../../identity.constants.js';
import {
  type StaffSwitchInConfig,
  staffSwitchInConfig,
} from '../../../infrastructure/security/staff-switch-in.config.js';
import { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';
import { toSessionClient } from '../../mappers/client-info.mapper.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import { TenantsRepository } from '../../persistence/tenants.repository.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { StaffSwitchInCommand } from './staff-switch-in.command.js';

/**
 * Staff switch-in: fresh staff check → reason → tenant exists → sign `{ roles: ['admin'], staff: true }`
 * for `STAFF_SWITCH_IN_TTL_SEC` → `staff.switch_in` audit row in the tenant. No refresh token, no
 * session: the token simply expires (or `switch-out` denylists it).
 */
@CommandHandler(StaffSwitchInCommand)
export class StaffSwitchInHandler implements ICommandHandler<StaffSwitchInCommand> {
  constructor(
    private readonly users: UsersRepository,
    private readonly tenants: TenantsRepository,
    private readonly tokens: TokenIssuer,
    private readonly audit: TenantAuditLog,
    @Inject(staffSwitchInConfig.KEY) private readonly config: StaffSwitchInConfig,
  ) {}

  async execute(command: StaffSwitchInCommand): Promise<StaffAccessToken> {
    if (!(await this.users.isPlatformStaff(command.staffUserId)))
      throw new NotPlatformStaffException();

    const reason = command.reason.trim();
    if (reason.length === 0 || reason.length > IDENTITY_LIMITS.SWITCH_IN_REASON_MAX_LENGTH) {
      throw new DomainValidationException('Invalid switch-in reason', {
        issues: [
          {
            path: 'reason',
            message: `Must be 1-${IDENTITY_LIMITS.SWITCH_IN_REASON_MAX_LENGTH} characters`,
          },
        ],
      });
    }

    const tenant =
      isUuid(command.tenantId) && !isPlatformTenantId(command.tenantId)
        ? await this.tenants.findById(command.tenantId)
        : null;
    if (tenant === null) throw new EntityNotFoundException('Tenant', command.tenantId);

    const staff = await this.users.findById(command.staffUserId);
    if (staff === null) throw new NotPlatformStaffException();

    const access = await this.tokens.issueAccessToken(
      { id: staff.id, email: staff.email, tenantId: tenant.id, roles: ['admin'], staff: true },
      { ttlSec: this.config.ttlSec },
    );
    const client = toSessionClient(command.client);
    const auditEventId = await this.audit.record({
      tenantId: tenant.id,
      actorId: staff.id,
      type: AUDIT_EVENT_TYPES.STAFF_SWITCH_IN,
      data: {
        reason,
        accessTokenJti: access.jti,
        expiresAt: new Date(access.exp * 1_000).toISOString(),
        ip: client.ip,
        userAgent: client.userAgent,
      },
    });
    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      tokenType: BEARER_TOKEN_TYPE,
      tenantId: tenant.id,
      auditEventId,
    };
  }
}
