import type { MyTenant } from '@domain/identity-contracts';
import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import {
  createPrincipal,
  EntityNotFoundException,
  generateId,
  runWithPrincipal,
} from '@platform/common';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import { deriveTenantSlug } from '../../../domain/tenant-slug.js';
import { normalizeTenantName, toMyTenantContract } from '../../mappers/tenancy.mapper.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { requireSelf } from '../../services/tenant-actor.js';
import { TenantBootstrap } from '../../services/tenant-bootstrap.elevated.js';
import { CreateTenantCommand } from './create-tenant.command.js';

/**
 * `POST /v1/tenants` (plan B3 Task 12 flow table): the tenant id is generated first, then ONE unit
 * of work as `{ user, newTenant, ['owner'] }`: tenant and owner membership (`tenant-bootstrap`),
 * and the read-back of the new membership (only that principal sees the new tenant's row).
 */
@CommandHandler(CreateTenantCommand)
export class CreateTenantHandler implements ICommandHandler<CreateTenantCommand> {
  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly transactions: TransactionRunner,
    private readonly bootstrap: TenantBootstrap,
    private readonly users: UsersRepository,
    private readonly events: EventBus,
  ) {}

  async execute({ userId, name }: CreateTenantCommand): Promise<MyTenant> {
    requireSelf(userId);
    const tenantName = normalizeTenantName(name);
    // The membership event carries the owner's email and display name: as the caller, its own row.
    const ownerUser = await this.users.findById(userId);
    if (ownerUser === null) throw new EntityNotFoundException('User', userId);
    const id = generateId();
    const owner = createPrincipal({ userId, tenantId: id, roles: ['owner'] });
    // Tenant and owner membership in one transaction: never a tenant without an owner.
    const membership = await runWithPrincipal(owner, () =>
      this.transactions.run(async () => {
        await this.bootstrap.create(
          { id, slug: deriveTenantSlug(tenantName, id), name: tenantName, personal: false },
          userId,
          null,
        );
        return (await this.memberships.listForUser(userId)).find((m) => m.tenantId === id);
      }),
    );
    if (membership === undefined)
      throw new Error(`Tenant ${id} was created without its owner membership`);
    // Committed: publish the owner membership.
    this.events.publish(
      new MembershipCreatedEvent({
        tenantId: id,
        userId,
        email: ownerUser.email,
        displayName: ownerUser.displayName,
        actorId: userId,
        occurredAt: new Date(),
      }),
    );
    return toMyTenantContract(membership);
  }
}
