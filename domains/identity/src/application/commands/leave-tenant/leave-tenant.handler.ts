import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import { MembershipRemovedEvent } from '../../../domain/events/membership-removed.event.js';
import {
  LastOwnerException,
  TenantAccessDeniedException,
} from '../../../domain/identity.errors.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { requireTenantActor } from '../../services/tenant-actor.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { LeaveTenantCommand } from './leave-tenant.command.js';

@CommandHandler(LeaveTenantCommand)
export class LeaveTenantHandler implements ICommandHandler<LeaveTenantCommand> {
  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly transactions: TransactionRunner,
    private readonly audit: TenantAuditLog,
    private readonly events: EventBus,
  ) {}

  async execute({ tenantId, userId }: LeaveTenantCommand): Promise<void> {
    const principal = requireTenantActor(tenantId, userId);
    // A staff switch-in principal has no membership to leave.
    if (principal.staff) throw new TenantAccessDeniedException();
    await this.transactions.run(async () => {
      const owners = await this.memberships.countOwnersLocked(tenantId);
      const self = await this.memberships.find(tenantId, userId);
      if (self === null) throw new TenantAccessDeniedException();
      if (self.roles.includes('owner') && owners <= 1) throw new LastOwnerException();
      // Under RLS a refused DELETE matches no row instead of failing: never audit it as done.
      if (!(await this.memberships.delete(tenantId, userId)))
        throw new TenantAccessDeniedException();
      await this.audit.record({
        tenantId,
        actorId: userId,
        type: AUDIT_EVENT_TYPES.MEMBER_LEFT,
        data: { roles: [...self.roles] },
      });
    });
    this.events.publish(
      new MembershipRemovedEvent({ tenantId, userId, actorId: userId, occurredAt: new Date() }),
    );
  }
}
