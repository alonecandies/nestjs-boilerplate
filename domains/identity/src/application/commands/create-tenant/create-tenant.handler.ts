import type { MyTenant } from '@domain/identity-contracts';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { generateId } from '@platform/common';
import { deriveTenantSlug } from '../../../domain/tenant-slug.js';
import { normalizeTenantName, toMyTenantContract } from '../../mappers/tenancy.mapper.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TenantsRepository } from '../../persistence/tenants.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { requireSelf } from '../../services/tenant-actor.js';
import { CreateTenantCommand } from './create-tenant.command.js';

@CommandHandler(CreateTenantCommand)
export class CreateTenantHandler implements ICommandHandler<CreateTenantCommand> {
  constructor(
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute({ userId, name }: CreateTenantCommand): Promise<MyTenant> {
    requireSelf(userId);
    const tenantName = normalizeTenantName(name);
    const id = generateId();
    // Tenant and owner membership in one transaction: never a tenant without an owner.
    await this.transactions.run(async () => {
      await this.tenants.insert({
        id,
        slug: deriveTenantSlug(tenantName, id),
        name: tenantName,
        personal: false,
      });
      await this.memberships.insert({ tenantId: id, userId, roles: ['owner'], lastActiveAt: null });
    });
    const membership = (await this.memberships.listForUser(userId)).find((m) => m.tenantId === id);
    if (membership === undefined)
      throw new Error(`Tenant ${id} was created without its owner membership`);
    return toMyTenantContract(membership);
  }
}
