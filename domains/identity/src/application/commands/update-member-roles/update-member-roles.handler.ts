import type { Member } from '@domain/identity-contracts';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { EntityNotFoundException, SystemContext } from '@platform/common';
import { LastOwnerException } from '../../../domain/identity.errors.js';
import { assertCanAssignRoles, parseTenantRoles } from '../../../domain/member-roles.policy.js';
import { toMemberContract } from '../../mappers/member.mapper.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { MembershipsSystemRepository } from '../../persistence/memberships.system-repository.js';
import { SYSTEM_READS } from '../../persistence/system-reads.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { actorTenantRoles, requireTenantActor } from '../../services/tenant-actor.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { UpdateMemberRolesCommand } from './update-member-roles.command.js';

@CommandHandler(UpdateMemberRolesCommand)
export class UpdateMemberRolesHandler implements ICommandHandler<UpdateMemberRolesCommand> {
  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly membershipsSystem: MembershipsSystemRepository,
    private readonly transactions: TransactionRunner,
    private readonly audit: TenantAuditLog,
  ) {}

  async execute({ tenantId, actorId, userId, roles }: UpdateMemberRolesCommand): Promise<Member> {
    const principal = requireTenantActor(tenantId, actorId);
    const next = parseTenantRoles(roles);
    await this.transactions.run(async () => {
      // Lock first: every owner change in this tenant is serialised from here to COMMIT.
      const owners = await this.memberships.countOwnersLocked(tenantId);
      // Read the actor's roles AFTER the lock: an owner demoted by a concurrent request that
      // committed while we waited must not act with the rank they just lost.
      const actor = await actorTenantRoles(principal, this.memberships);
      const target = await this.memberships.find(tenantId, userId);
      if (target === null) throw new EntityNotFoundException('Member', userId);
      assertCanAssignRoles(actor, target.roles, next);
      if (target.roles.includes('owner') && !next.includes('owner') && owners <= 1) {
        throw new LastOwnerException();
      }
      await this.memberships.updateRoles(tenantId, userId, next);
      await this.audit.record({
        tenantId,
        actorId,
        type: AUDIT_EVENT_TYPES.MEMBER_ROLES_CHANGED,
        data: { userId, from: [...target.roles], to: next },
      });
    });
    // After COMMIT: the profile is a co-member's row (a system read on another connection, which
    // sees only committed rows), scoped in the SQL to the tenant asserted above.
    const member = await SystemContext.run(SYSTEM_READS.MEMBER_DIRECTORY, () =>
      this.membershipsSystem.findMember(tenantId, userId),
    );
    if (member === null) throw new EntityNotFoundException('Member', userId);
    return toMemberContract(member);
  }
}
