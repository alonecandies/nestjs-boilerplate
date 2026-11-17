import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { EntityNotFoundException } from '@platform/common';
import { RlsElevation } from '@platform/database';
import { LastOwnerException } from '../../../domain/identity.errors.js';
import { assertCanRemove } from '../../../domain/member-roles.policy.js';
import { IdentityPermission } from '../../../identity.permissions.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { actorTenantRoles, requireTenantActor } from '../../services/tenant-actor.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { RemoveMemberCommand } from './remove-member.command.js';

@CommandHandler(RemoveMemberCommand)
export class RemoveMemberHandler implements ICommandHandler<RemoveMemberCommand> {
  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly transactions: TransactionRunner,
    private readonly audit: TenantAuditLog,
    private readonly elevation: RlsElevation,
  ) {}

  async execute({ tenantId, actorId, userId }: RemoveMemberCommand): Promise<void> {
    const principal = requireTenantActor(tenantId, actorId);
    await this.transactions.run(async () => {
      // Route permission MembersManage: elevated (this tenant only) for the whole unit of work.
      await this.elevation.elevate(IdentityPermission.MembersManage);
      const owners = await this.memberships.countOwnersLocked(tenantId);
      // After the lock, as in UpdateMemberRolesHandler.
      const actor = await actorTenantRoles(principal, this.memberships);
      const target = await this.memberships.find(tenantId, userId);
      if (target === null) throw new EntityNotFoundException('Member', userId);
      assertCanRemove(actor, target.roles);
      if (target.roles.includes('owner') && owners <= 1) throw new LastOwnerException();
      // Under RLS a refused DELETE matches no row instead of failing: never audit it as done.
      if (!(await this.memberships.delete(tenantId, userId))) {
        throw new EntityNotFoundException('Member', userId);
      }
      await this.audit.record({
        tenantId,
        actorId,
        type: AUDIT_EVENT_TYPES.MEMBER_REMOVED,
        data: { userId, roles: [...target.roles] },
      });
    });
  }
}
