import type { MyTenant } from '@domain/identity-contracts';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { deriveTenantSlug } from '../../../domain/tenant-slug.js';
import { normalizeTenantName, toMyTenantContract } from '../../mappers/tenancy.mapper.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
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
  ) {}

  async execute({ userId, name }: CreateTenantCommand): Promise<MyTenant> {
    requireSelf(userId);
    const tenantName = normalizeTenantName(name);
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
    return toMyTenantContract(membership);
  }
}
