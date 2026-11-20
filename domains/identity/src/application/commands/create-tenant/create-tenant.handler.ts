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
import { IdentityIntegrationEvents } from '../../services/identity-integration-events.service.js';
import { requireSelf } from '../../services/tenant-actor.js';
import { TenantBootstrap } from '../../services/tenant-bootstrap.elevated.js';
import { CreateTenantCommand } from './create-tenant.command.js';

/**
 * `POST /v1/tenants` (plan B3 Task 12 flow table): the tenant id is generated first, then ONE unit
 * of work as `{ user, newTenant, ['owner'] }`: tenant and owner membership (`tenant-bootstrap`),
 * the read-back of the new membership (only that principal sees the new tenant's row) and the
 * `identity.membership-created.v1` outbox row.
 */
@CommandHandler(CreateTenantCommand)
export class CreateTenantHandler implements ICommandHandler<CreateTenantCommand> {
  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly transactions: TransactionRunner,
    private readonly bootstrap: TenantBootstrap,
    private readonly users: UsersRepository,
    private readonly events: EventBus,
    private readonly integrationEvents: IdentityIntegrationEvents,
  ) {}

  async execute({ userId, name }: CreateTenantCommand): Promise<MyTenant> {
    requireSelf(userId);
    const tenantName = normalizeTenantName(name);
    // The membership event carries the owner's email and display name: as the caller, its own row.
    const ownerUser = await this.users.findById(userId);
    if (ownerUser === null) throw new EntityNotFoundException('User', userId);
    const id = generateId();
    const owner = createPrincipal({ userId, tenantId: id, roles: ['owner'] });
    const created = new MembershipCreatedEvent({
      tenantId: id,
      userId,
      email: ownerUser.email,
      displayName: ownerUser.displayName,
      actorId: userId,
      occurredAt: new Date(),
    });
    // Tenant, owner membership and its outbox row in one transaction: never a tenant without an
    // owner, never an owner membership without its event.
    const membership = await runWithPrincipal(owner, () =>
      this.transactions.run(async () => {
        await this.bootstrap.create(
          { id, slug: deriveTenantSlug(tenantName, id), name: tenantName, personal: false },
          userId,
          null,
        );
        const mine = (await this.memberships.listForUser(userId)).find((m) => m.tenantId === id);
        if (mine !== undefined) await this.integrationEvents.membershipCreated(created);
        return mine;
      }),
    );
    if (membership === undefined)
      throw new Error(`Tenant ${id} was created without its owner membership`);
    // Committed: in-process handlers see the owner membership.
    this.events.publish(created);
    return toMyTenantContract(membership);
  }
}
