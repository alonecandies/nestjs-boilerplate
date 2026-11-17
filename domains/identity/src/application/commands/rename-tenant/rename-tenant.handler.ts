import type { Tenant } from '@domain/identity-contracts';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  EntityNotFoundException,
  PermissionDeniedException,
  satisfiesTenantRole,
} from '@platform/common';
import { RlsElevation } from '@platform/database';
import { IdentityPermission } from '../../../identity.permissions.js';
import { normalizeTenantName, toTenantContract } from '../../mappers/tenancy.mapper.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TenantsRepository } from '../../persistence/tenants.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { actorTenantRoles, requireTenantActor } from '../../services/tenant-actor.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { RenameTenantCommand } from './rename-tenant.command.js';

@CommandHandler(RenameTenantCommand)
export class RenameTenantHandler implements ICommandHandler<RenameTenantCommand> {
  constructor(
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly transactions: TransactionRunner,
    private readonly audit: TenantAuditLog,
    private readonly elevation: RlsElevation,
  ) {}

  async execute({ tenantId, actorId, name }: RenameTenantCommand): Promise<Tenant> {
    const principal = requireTenantActor(tenantId, actorId);
    const to = normalizeTenantName(name);
    if (!satisfiesTenantRole(await actorTenantRoles(principal, this.memberships), 'owner')) {
      throw new PermissionDeniedException('Only an owner can rename the workspace', {
        details: { required: ['tenant:manage'] },
      });
    }
    return this.transactions.run(async () => {
      // Route permission TenantManage: elevated (this tenant only) for the whole unit of work.
      await this.elevation.elevate(IdentityPermission.TenantManage);
      const tenant = await this.tenants.findById(tenantId);
      if (tenant === null) throw new EntityNotFoundException('Tenant', tenantId);
      // Under RLS a refused UPDATE matches no row instead of failing: never audit it as done.
      if (!(await this.tenants.rename(tenantId, to))) {
        throw new EntityNotFoundException('Tenant', tenantId);
      }
      await this.audit.record({
        tenantId,
        actorId,
        type: AUDIT_EVENT_TYPES.TENANT_RENAMED,
        data: { from: tenant.name, to },
      });
      return toTenantContract({ ...tenant, name: to });
    });
  }
}
