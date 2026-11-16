import type { MyTenantList } from '@domain/identity-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { toMyTenantContract } from '../../mappers/tenancy.mapper.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { requireSelf } from '../../services/tenant-actor.js';
import { ListMyTenantsQuery } from './list-my-tenants.query.js';

@QueryHandler(ListMyTenantsQuery)
export class ListMyTenantsHandler implements IQueryHandler<ListMyTenantsQuery> {
  constructor(private readonly memberships: MembershipsRepository) {}

  async execute({ userId }: ListMyTenantsQuery): Promise<MyTenantList> {
    requireSelf(userId);
    return { items: (await this.memberships.listForUser(userId)).map(toMyTenantContract) };
  }
}
